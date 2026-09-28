import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from './store.js';
import { privateWrite } from './setup.js';
// A protocol demonstration, not live Claude/DeepSeek/Gemini model invocations.
// Every named peer is a separate MCP server process using the same SQLite hub.
export async function runDemo() {
    const directory = mkdtempSync(join(tmpdir(), 'project-relay-demo-'));
    const store = new Store(join(directory, 'relay.sqlite'));
    const project = store.createProject(directory, 'Cross-tool collaboration demo');
    const clients = [];
    async function call(client, name, args = {}) {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content.find(item => item.type === 'text');
        if (!content || content.type !== 'text')
            throw new Error('Missing tool response');
        const body = JSON.parse(content.text);
        if (!body.ok)
            throw new Error(`${body.error.code}: ${body.error.message}`);
        return body.data;
    }
    try {
        for (const id of ['claude-vscode', 'deepseek', 'gemini-antigravity']) {
            const path = join(directory, `${id}.identity.json`);
            privateWrite(path, store.issueIdentity(project.id, id));
            const client = new Client({ name: id, version: 'demo' });
            clients.push(client);
            await client.connect(new StdioClientTransport({ command: process.execPath,
                args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp', '--identity', path], stderr: 'pipe' }));
            await call(client, 'relay_heartbeat', { harness: id, capabilities: ['code', 'review'] });
        }
        const [claude, deepseek, gemini] = clients;
        console.log('1. Three independent MCP clients joined the same project.');
        await call(claude, 'relay_put_note', { key: 'api-contract', content: 'GET /health returns { ok: true }. Add tests before handoff.', expectedRevision: 0 });
        const task = await call(claude, 'relay_create_task', { title: 'Implement health endpoint', description: 'Use the api-contract shared note.' });
        const owner = await call(claude, 'relay_claim_task', { taskId: task.id });
        const files = await call(claude, 'relay_claim_files', { paths: ['src/health.ts'] });
        console.log('2. Claude shared the API contract and claimed the task and file.');
        const conflict = await deepseek.callTool({ name: 'relay_claim_files', arguments: { paths: ['src/health.ts'] } });
        if (!conflict.isError)
            throw new Error('Expected a conflicting file claim to fail');
        console.log('3. DeepSeek’s overlapping file claim was rejected.');
        await call(claude, 'relay_release_files', { claims: files.claims.map(({ path, leaseToken }) => ({ path, leaseToken })) });
        await call(claude, 'relay_handoff', { taskId: task.id, leaseToken: owner.leaseToken, to: 'deepseek', summary: 'Demo implementation ready. Review contract and add test evidence.' });
        const inbox = await call(deepseek, 'relay_inbox');
        const received = await call(deepseek, 'relay_claim_task', { taskId: task.id });
        await call(deepseek, 'relay_ack', { messageIds: inbox.messages.map((m) => m.id) });
        console.log('4. DeepSeek received the handoff, claimed the task, and acknowledged it.');
        await call(deepseek, 'relay_update_task', { taskId: task.id, leaseToken: received.leaseToken, state: 'done', summary: 'Demo result: contract reviewed; no actual repository files changed.' });
        await call(deepseek, 'relay_send', { kind: 'result', body: 'Health endpoint demo is complete. Shared task includes the result.' });
        const review = await call(gemini, 'relay_inbox');
        await call(gemini, 'relay_ack', { messageIds: review.messages.map((m) => m.id) });
        console.log('5. Gemini received the broadcast and read the shared result.');
        console.log('PASS — real MCP transports and durable shared state; no model API calls or charges.');
    }
    finally {
        await Promise.allSettled(clients.map(client => client.close()));
        store.close();
        rmSync(directory, { recursive: true, force: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runDemo().catch(error => { console.error(error.message); process.exitCode = 1; });
}
