import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { projectConnection } from '../plugin.js';
import { Store } from '../store.js';
import { identityPath } from '../setup.js';
import { RelayError } from '../errors.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const pluginCli = join(repo, 'plugin/runtime/cli.js');
const manifest = JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers['project-relay'];
const init = async (project: string, state: string) => JSON.parse((await exec(process.execPath,
  [pluginCli, 'init', '--project', project, '--state', state, '--agents', 'claude-code,deepseek,gemini-antigravity'])).stdout);
const errorCode = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;
async function peer(project: string, state: string) {
  const client = new Client({ name: 'plugin-test', version: '1.0.0' });
  const args = manifest.args.map((arg: string) => arg.replace('${CLAUDE_PLUGIN_ROOT}', repo).replace('${CLAUDE_PROJECT_DIR}', project));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...args, '--state', state], stderr: 'pipe' }));
  return client;
}
async function call(client: Client, name: string, input = {}) {
  const result = await client.callTool({ name, arguments: input });
  const content = result.content.find(item => item.type === 'text');
  assert.ok(content?.type === 'text');
  return { ...JSON.parse(content.text), isError: !!result.isError };
}

test('plugin connects before setup, creates no state, and enrolls without restarting', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-plugin-'));
  const project = join(directory, 'project with spaces'); mkdirSync(project);
  const state = join(directory, 'state');
  const client = await peer(project, state);
  try {
    assert.equal((await client.listTools()).tools.length, 17);
    const before = await call(client, 'relay_status');
    assert.equal(before.error.code, 'PROJECT_NOT_ENROLLED');
    assert.equal(before.isError, true);
    assert.equal(existsSync(state), false);
    const enrolled = await init(project, state);
    const status = await call(client, 'relay_status');
    assert.equal(status.data.self.projectId, enrolled.project.id);
    assert.equal(status.data.self.agentId, 'claude-code');
    assert.equal(status.isError, false);
    const retry = await init(project, state);
    assert.equal(retry.project.id, enrolled.project.id);
    assert.equal((await call(client, 'relay_status')).ok, true);
  } finally { await client.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('installed plugin command keeps simultaneous projects isolated and rejects project overrides', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-plugin-isolation-'));
  const state = join(directory, 'state');
  const roots = ['a', 'b'].map(name => { const path = join(directory, name); mkdirSync(path); return path; });
  const projects = [];
  for (const root of roots) projects.push(await init(root, state));
  const clients = await Promise.all(roots.map(root => peer(root, state)));
  try {
    for (const [index, client] of clients.entries()) {
      assert.equal((await call(client, 'relay_status')).data.self.projectId, projects[index].project.id);
      assert.equal((await call(client, 'relay_put_note', { key: 'contract', content: roots[index], expectedRevision: 0 })).ok, true);
    }
    assert.equal((await call(clients[0]!, 'relay_notes')).data.notes[0].content, roots[0]);
    assert.equal((await call(clients[1]!, 'relay_notes')).data.notes[0].content, roots[1]);
    const override = await clients[0]!.callTool({ name: 'relay_status', arguments: { projectId: projects[1].project.id } });
    assert.equal(override.isError, true);
    assert.equal((await call(clients[0]!, 'relay_status')).data.self.projectId, projects[0].project.id);
    const child = join(roots[0]!, 'nested'); mkdirSync(child);
    const unselected = projectConnection(child, state, 'claude-code');
    assert.throws(() => unselected.get(), errorCode('PROJECT_NOT_ENROLLED'));
    unselected.close();
  } finally { await Promise.all(clients.map(client => client.close())); rmSync(directory, { recursive: true, force: true }); }
});

test('plugin rejects mismatched and revoked identities without replacing credentials', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-plugin-identity-'));
  const state = join(directory, 'state');
  const a = join(directory, 'a'), b = join(directory, 'b'); mkdirSync(a); mkdirSync(b);
  try {
    const first = await init(a, state), second = await init(b, state);
    const firstPath = identityPath(state, first.project.id, 'claude-code');
    copyFileSync(identityPath(state, second.project.id, 'claude-code'), firstPath);
    const mismatched = projectConnection(a, state, 'claude-code');
    assert.throws(() => mismatched.get(), errorCode('IDENTITY_MISMATCH'));
    mismatched.close();
    const store = new Store(join(state, 'relay.sqlite'));
    const bound = projectConnection(b, state, 'claude-code');
    const connection = bound.get();
    store.revoke(second.project.id, 'claude-code');
    assert.throws(() => connection.store.authenticate(connection.token));
    bound.close(); store.close();
    assert.throws(() => bound.get(), errorCode('CONNECTION_CLOSED'));
    const revoked = projectConnection(b, state, 'claude-code');
    assert.throws(() => revoked.get()); revoked.close();
    assert.throws(() => projectConnection('${CLAUDE_PROJECT_DIR}', state, 'claude-code'), errorCode('INVALID_PROJECT'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
