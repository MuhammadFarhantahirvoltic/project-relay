import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { PROTOCOL_VERSION } from './store.js';
import { dispatch, toolCatalog } from './tools.js';
import { createMcpServer } from './mcp.js';
import { errorBody, RelayError, requireThat } from './errors.js';
const MAX_BODY = 256 * 1024;
function json(response, status, value) {
    if (response.destroyed || response.writableEnded)
        return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
}
function readJson(request) {
    requireThat(/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''), 'CONTENT_TYPE', 'Use Content-Type: application/json.', 415);
    requireThat(Number(request.headers['content-length'] ?? 0) <= MAX_BODY, 'BODY_TOO_LARGE', 'Request exceeds 256 KiB.', 413);
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new RelayError('BODY_TOO_LARGE', 'Request exceeds 256 KiB.', 413));
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (size > MAX_BODY)
                return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch {
                reject(new RelayError('INVALID_JSON', 'Request body must be valid JSON.'));
            }
        });
        request.on('error', reject);
        request.on('aborted', () => reject(new RelayError('CANCELLED', 'Request was disconnected.', 499)));
    });
}
export async function startHttp(store, port = 7331) {
    requireThat(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT', 'Port must be between 0 and 65535.');
    const pending = new Set();
    const counts = new Map();
    const server = createServer(async (request, response) => {
        const abort = new AbortController();
        pending.add(abort);
        let quotaKey;
        response.once('close', () => {
            abort.abort();
            pending.delete(abort);
            if (quotaKey) {
                const count = (counts.get(quotaKey) ?? 1) - 1;
                if (count)
                    counts.set(quotaKey, count);
                else
                    counts.delete(quotaKey);
            }
        });
        try {
            const actualPort = server.address().port;
            const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
            requireThat(hosts.has(request.headers.host ?? ''), 'HOST_REJECTED', 'Only the local relay host is allowed.', 403);
            if (request.headers.origin)
                requireThat([...hosts].some(host => request.headers.origin === `http://${host}`), 'ORIGIN_REJECTED', 'Cross-origin browser requests are not allowed.', 403);
            const url = new URL(request.url ?? '/', 'http://localhost');
            requireThat(!url.search, 'QUERY_REJECTED', 'Credentials and tool arguments must not be sent in query strings.');
            if (url.pathname === '/health' && request.method === 'GET') {
                json(response, 200, { ok: true, service: 'project-relay', protocolVersion: PROTOCOL_VERSION });
                return;
            }
            const auth = request.headers.authorization;
            requireThat(auth && auth.startsWith('Bearer '), 'UNAUTHORIZED', 'A Bearer credential is required.', 401);
            const token = auth.slice(7);
            const actor = store.authenticate(token);
            const key = `${actor.projectId}:${actor.agentId}`;
            requireThat((counts.get(key) ?? 0) < 16, 'TOO_MANY_REQUESTS', 'Maximum 16 concurrent requests per agent.', 429);
            quotaKey = key;
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (url.pathname === '/v1/tools' && request.method === 'GET') {
                json(response, 200, { protocolVersion: PROTOCOL_VERSION, tools: toolCatalog() });
                return;
            }
            if (url.pathname === '/mcp') {
                requireThat(request.method === 'POST', 'METHOD_NOT_ALLOWED', 'This stateless MCP endpoint accepts POST requests.', 405);
                const body = await readJson(request);
                const handler = createMcpHandler(() => createMcpServer(store, token, abort.signal), {
                    maxRequestBodySize: MAX_BODY,
                });
                response.once('close', () => { void handler.close().catch(() => { }); });
                const headers = new Headers();
                for (const [name, value] of Object.entries(request.headers))
                    if (value !== undefined)
                        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
                const webRequest = new Request(`http://127.0.0.1:${actualPort}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal });
                const reply = await handler.fetch(webRequest, { parsedBody: body });
                if (!response.destroyed) {
                    response.writeHead(reply.status, { ...Object.fromEntries(reply.headers.entries()), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                    response.end(await reply.text());
                }
                return;
            }
            const match = /^\/v1\/tools\/(relay_[a-z_]+)$/.exec(url.pathname);
            requireThat(match, 'NOT_FOUND', 'Unknown endpoint.', 404);
            requireThat(request.method === 'POST', 'METHOD_NOT_ALLOWED', 'Tool calls require POST.', 405);
            const result = await dispatch(store, token, match[1], await readJson(request), abort.signal);
            json(response, 200, result);
        }
        catch (error) {
            if (!(error instanceof RelayError))
                console.error('Project Relay request failed:', error instanceof Error ? error.name : 'unknown error');
            json(response, error instanceof RelayError ? error.status : 500, { protocolVersion: PROTOCOL_VERSION, ok: false, error: errorBody(error) });
        }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}`, server,
        close: async () => {
            for (const controller of pending)
                controller.abort();
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
                server.closeAllConnections();
            });
        },
    };
}
