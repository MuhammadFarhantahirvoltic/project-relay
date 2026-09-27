import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as nodeRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../store.js';
import { startHttp } from '../http.js';
import { privateWrite } from '../setup.js';
import { dispatch, TOOLS } from '../tools.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const python = fileURLToPath(new URL('../../examples/harness_adapter.py', import.meta.url));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-integration-'));
  const store = new Store(join(directory, 'relay.sqlite'));
  const project = store.createProject(directory, 'Integration');
  const identities = ['claude', 'deepseek', 'gemini'].map(id => store.issueIdentity(project.id, id));
  const identityFiles = identities.map(identity => {
    const path = join(directory, `${identity.agentId}.identity.json`); privateWrite(path, identity); return path;
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, project, identities, identityFiles };
}

async function peer(path: string, modern = false) {
  const client = new Client({ name: 'relay-integration', version: '1.0.0' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--identity', path], stderr: 'pipe' });
  try { await client.connect(transport); return client; }
  catch (error) { await transport.close(); throw error; }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content.find(item => item.type === 'text');
  assert.ok(block && block.type === 'text');
  const body = JSON.parse(block.text);
  return { ...body, isError: !!result.isError };
}

test('three independent MCP processes exchange messages and recover unread messages on reconnect', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const clients = await Promise.all(f.identityFiles.map(path => peer(path)));
  try {
    assert.equal((await clients[0]!.listTools()).tools.length, TOOLS.length);
    const guide = await clients[0]!.readResource({ uri: 'relay://guide' });
    assert.match(JSON.stringify(guide), /untrusted data/);
    const sent = await call(clients[0]!, 'relay_send', { to: 'deepseek', body: 'Check the API', kind: 'question' });
    assert.equal(sent.ok, true);
    assert.equal((await call(clients[1]!, 'relay_inbox')).data.messages[0].id, sent.data.id);
    assert.equal((await call(clients[2]!, 'relay_inbox')).data.messages.length, 0);
    await clients[1]!.close();
    clients[1] = await peer(f.identityFiles[1]!);
    assert.equal((await call(clients[1]!, 'relay_inbox')).data.messages[0].id, sent.data.id);
    await call(clients[1]!, 'relay_ack', { messageIds: [sent.data.id] });
    await call(clients[1]!, 'relay_send', { to: 'claude', replyTo: sent.data.id, kind: 'answer', body: 'API checked' });
    assert.equal((await call(clients[0]!, 'relay_inbox')).data.messages[0].body, 'API checked');
    await call(clients[2]!, 'relay_put_note', { key: 'review', content: 'Tests passed', expectedRevision: 0 });
    assert.equal((await call(clients[0]!, 'relay_notes')).data.notes[0].content, 'Tests passed');
  } finally { await Promise.all(clients.map(client => client.close())); }
});

test('concurrent task and file claims across processes have exactly one winner', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const clients = await Promise.all(f.identityFiles.map(path => peer(path)));
  try {
    const task = (await call(clients[0]!, 'relay_create_task', { title: 'Race', description: 'Only one worker' })).data;
    const claims = await Promise.all(clients.map(client => call(client, 'relay_claim_task', { taskId: task.id })));
    assert.equal(claims.filter(r => r.ok).length, 1);
    assert.equal(claims.filter(r => r.error?.code === 'TASK_UNAVAILABLE').length, 2);
    const files = await Promise.all(clients.map(client => call(client, 'relay_claim_files', { paths: ['src/shared.ts'] })));
    assert.equal(files.filter(r => r.ok).length, 1);
    assert.equal(files.filter(r => r.error?.code === 'FILE_CONFLICT').length, 2);
  } finally { await Promise.all(clients.map(client => client.close())); }
});

test('modern MCP negotiation works over stdio', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const client = await peer(f.identityFiles[0]!, true);
  try {
    assert.equal((await client.listTools()).tools.length, TOOLS.length);
    assert.equal((await call(client, 'relay_status')).data.self.agentId, 'claude');
  } finally { await client.close(); }
});

test('HTTP authentication, project isolation, validation, DNS rebinding, and payload bounds', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const http = await startHttp(f.store, 0);
  const request = (path: string, token?: string, input: unknown = {}, extra: Record<string, string> = {}) => fetch(http.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(input),
  });
  try {
    assert.equal((await fetch(http.url + '/health')).status, 200);
    assert.equal((await request('/v1/tools/relay_status')).status, 401);
    assert.equal((await request('/v1/tools/relay_status', 'invalid')).status, 401);
    assert.equal((await request('/v1/tools/relay_status', f.identities[0]!.token, {}, { Origin: 'https://evil.example' })).status, 403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = nodeRequest(http.url + '/v1/tools/relay_status', {
        method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${f.identities[0]!.token}`, 'Content-Type': 'application/json' },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await request('/v1/tools/relay_status', f.identities[0]!.token, { agentId: 'gemini' })).status, 400);
    assert.equal((await request('/v1/tools/relay_send', f.identities[0]!.token, { body: 'x'.repeat(300_000) })).status, 413);
    const malformed = await fetch(http.url + '/v1/tools/relay_send', { method: 'POST', headers: { Authorization: `Bearer ${f.identities[0]!.token}`, 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(malformed.status, 400);
    assert.equal((await request('/v1/tools/relay_status?token=never', f.identities[0]!.token)).status, 400);
    const other = f.store.issueIdentity(f.store.createProject('/different', 'Different').id, 'claude');
    await request('/v1/tools/relay_send', f.identities[0]!.token, { to: 'deepseek', body: 'Restricted to project' });
    assert.equal((await (await request('/v1/tools/relay_inbox', other.token)).json() as any).data.messages.length, 0);
    const catalogue = await fetch(http.url + '/v1/tools', { headers: { Authorization: `Bearer ${f.identities[0]!.token}` } });
    assert.equal((await catalogue.json() as any).tools.length, TOOLS.length);
  } finally { await http.close(); }
});

for (const modern of [false, true]) {
  test(`MCP over HTTP interoperates with REST (${modern ? 'modern' : 'legacy'} negotiation)`, { timeout: 20_000 }, async t => {
    const f = fixture(t);
    const http = await startHttp(f.store, 0);
    const client = new Client({ name: 'http-client', version: '1.0.0' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    const transport = new StreamableHTTPClientTransport(new URL(http.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${f.identities[0]!.token}` } } });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, TOOLS.length);
      await call(client, 'relay_send', { to: 'deepseek', body: 'MCP to REST' });
      const response = await fetch(http.url + '/v1/tools/relay_inbox', { method: 'POST', headers: { Authorization: `Bearer ${f.identities[1]!.token}`, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal((await response.json() as any).data.messages[0].body, 'MCP to REST');
      f.store.revoke(f.identities[0]!.projectId, f.identities[0]!.agentId);
      await assert.rejects(call(client, 'relay_status'));
    } finally { await client.close(); await http.close(); }
  });
}

test('Python harness adapter exchanges a real authenticated HTTP message', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const http = await startHttp(f.store, 0);
  try {
    const result = await exec('python3', [python, '--identity', f.identityFiles[1]!, '--url', http.url, '--tool', 'relay_send', '--arguments', JSON.stringify({ to: 'claude', body: 'From a Python harness' })]);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const inbox = (await dispatch(f.store, f.identities[0]!.token, 'relay_inbox', {})).data as any;
    assert.equal(inbox.messages[0].body, 'From a Python harness');
  } finally { await http.close(); }
});

test('CLI init is repeatable and generates private, working host configs', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-setup-'));
  try {
    const args = [cli, 'init', '--project', directory, '--state', join(directory, '.relay')];
    const first = JSON.parse((await exec(process.execPath, args)).stdout);
    const repeated = JSON.parse((await exec(process.execPath, args)).stdout);
    assert.equal(first.project.id, repeated.project.id);
    assert.equal(first.connections.length, 3);
    for (const connection of first.connections) {
      const config = JSON.parse(readFileSync(connection.configs.claude, 'utf8'));
      const server = Object.values(config.mcpServers)[0] as any;
      assert.equal(server.args[0], cli);
      assert.equal(server.args[3], connection.identityFile);
      assert.doesNotMatch(JSON.stringify(config), /pr_[A-Za-z0-9_-]{40}/);
      assert.equal(statSync(connection.identityFile).mode & 0o777, 0o600);
    }
    const callResult = await exec(process.execPath, [cli, 'call', '--identity', first.connections[0].identityFile, '--tool', 'relay_status']);
    assert.equal(JSON.parse(callResult.stdout).data.self.agentId, 'claude-vscode');
    await assert.rejects(exec(process.execPath, [cli, 'call', '--identity', first.connections[0].identityFile, '--tool', 'relay_status', '--port', '8000']));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
