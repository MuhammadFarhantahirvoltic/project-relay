import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store, type Identity } from '../store.js';
import { dispatch } from '../tools.js';
import { RelayError } from '../errors.js';
import { clientConfig, identityPath, privateWrite, projectConfigs } from '../setup.js';
import { startHttp } from '../http.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const agentIds = ['claude-vscode', 'deepseek', 'gemini-antigravity'];
const errorCode = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-projects-'));
  const state = join(directory, 'state');
  const store = new Store(join(state, 'relay.sqlite'));
  const groups = ['a', 'b'].map(label => {
    const root = join(directory, label, 'same-name');
    mkdirSync(root, { recursive: true });
    const project = store.createProject(root, 'Same name');
    const identities = agentIds.map(agent => store.issueIdentity(project.id, agent));
    for (const identity of identities) privateWrite(identityPath(state, project.id, identity.agentId), identity);
    return { project, identities };
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const call = async (identity: Identity, name: string, input: unknown = {}) => (await dispatch(store, identity.token, name, input)).data as any;
  return { directory, state, store, groups, clients, call };
}

test('same agent IDs in separate projects keep every conversation and ownership record isolated', async t => {
  const f = fixture(t);
  const [a, b] = f.groups;
  const [ac, ad, ag] = a!.identities as [Identity, Identity, Identity];
  const [bc, bd] = b!.identities as [Identity, Identity, Identity];
  const directA = await f.call(ac, 'relay_send', { to: 'deepseek', body: 'A only', dedupeKey: 'request-1' });
  const directB = await f.call(bc, 'relay_send', { to: 'deepseek', body: 'B only', dedupeKey: 'request-1' });
  assert.notEqual(directA.id, directB.id);
  await f.call(ac, 'relay_send', { body: 'A broadcast' });
  assert.deepEqual((await f.call(bd, 'relay_inbox')).messages.map((m: any) => m.body), ['B only']);
  await assert.rejects(f.call(bd, 'relay_ack', { messageIds: [directA.id] }), errorCode('MESSAGE_NOT_FOUND'));
  await assert.rejects(f.call(bd, 'relay_send', { body: 'Wrong thread', replyTo: directA.id }), errorCode('MESSAGE_NOT_FOUND'));
  await f.call(ad, 'relay_ack', { messageIds: [directA.id] });
  assert.equal((await f.call(bd, 'relay_inbox')).messages.length, 1);
  for (const [identity, content] of [[ac, 'A contract'], [bc, 'B contract']] as const) {
    await f.call(identity, 'relay_put_note', { key: 'api-contract', content, expectedRevision: 0 });
  }
  assert.equal((await f.call(ad, 'relay_notes')).notes[0].content, 'A contract');
  assert.equal((await f.call(bd, 'relay_notes')).notes[0].content, 'B contract');
  const taskA = await f.call(ac, 'relay_create_task', { title: 'Same task', description: 'A work', dedupeKey: 'task-1' });
  const taskB = await f.call(bc, 'relay_create_task', { title: 'Same task', description: 'B work', dedupeKey: 'task-1' });
  const ownerA = await f.call(ac, 'relay_claim_task', { taskId: taskA.id });
  const ownerB = await f.call(bc, 'relay_claim_task', { taskId: taskB.id });
  for (const tool of ['relay_tasks', 'relay_claim_task']) {
    await assert.rejects(f.call(bc, tool, { taskId: taskA.id }), errorCode('TASK_NOT_FOUND'));
  }
  await assert.rejects(f.call(bc, 'relay_update_task', { taskId: taskA.id, leaseToken: ownerA.leaseToken }), errorCode('TASK_NOT_FOUND'));
  await assert.rejects(f.call(bc, 'relay_handoff', { taskId: taskA.id, leaseToken: ownerA.leaseToken, to: 'deepseek', summary: 'Wrong project' }), errorCode('TASK_NOT_FOUND'));
  const fileA = await f.call(ac, 'relay_claim_files', { paths: ['src/api.ts'] });
  const fileB = await f.call(bc, 'relay_claim_files', { paths: ['src/api.ts'] });
  await assert.rejects(f.call(ag, 'relay_claim_files', { paths: ['src/api.ts'] }), errorCode('FILE_CONFLICT'));
  for (const tool of ['relay_release_files', 'relay_renew_files']) {
    await assert.rejects(f.call(bc, tool, { claims: [{ path: 'src/api.ts', leaseToken: fileA.claims[0].leaseToken }] }), errorCode('LEASE_LOST'));
  }
  await f.call(ac, 'relay_handoff', { taskId: taskA.id, leaseToken: ownerA.leaseToken, to: 'deepseek', summary: 'A handoff' });
  assert.equal((await f.call(ad, 'relay_inbox')).messages.filter((m: any) => m.kind === 'handoff').length, 1);
  assert.equal((await f.call(bd, 'relay_inbox')).messages.filter((m: any) => m.kind === 'handoff').length, 0);
  await f.call(ac, 'relay_heartbeat', { harness: 'A host' });
  assert.equal((await f.call(bd, 'relay_status')).agents.find((agent: any) => agent.id === 'claude-vscode').harness, '');
  for (const identity of [ad, bd]) {
    const events = (await f.call(identity, 'relay_events', { limit: 100 })).events;
    assert.ok(events.length > 0 && events.every((event: any) => event.projectId === identity.projectId));
  }
  f.store.revoke(ac.projectId, ac.agentId);
  assert.equal((await f.call(bc, 'relay_status')).self.projectId, bc.projectId);
  await f.call(bc, 'relay_renew_files', { claims: [{ path: 'src/api.ts', leaseToken: fileB.claims[0].leaseToken }] });
  await f.call(bc, 'relay_update_task', { taskId: taskB.id, leaseToken: ownerB.leaseToken, state: 'done' });
  assert.equal(f.store.listProjects().find(project => project.id === ac.projectId)!.activeAgents, 2);
  assert.equal(f.store.listProjects().find(project => project.id === bc.projectId)!.activeAgents, 3);
});

test('six MCP processes run two projects concurrently through generated configurations', { timeout: 25_000 }, async t => {
  const f = fixture(t);
  const projectIds = f.groups.map(group => group.project.id as string);
  const peers = await Promise.all(agentIds.map(async agentId => {
    const config = projectConfigs(f.state, agentId, projectIds, 'generic');
    return Promise.all(Object.values(config.mcpServers!).map(async (entry: any) => {
      const client = new Client({ name: agentId, version: '1.0.0' });
      f.clients.push(client);
      await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, stderr: 'pipe' }));
      return client;
    }));
  }));
  async function call(client: Client, name: string, input: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: input });
    const block = result.content.find(item => item.type === 'text');
    assert.ok(block && block.type === 'text');
    const body = JSON.parse(block.text);
    assert.equal(body.ok, true, JSON.stringify(body.error));
    return body.data;
  }
  await Promise.all(projectIds.map(async (projectId, index) => {
    const claude = peers[0]![index]!, deepseek = peers[1]![index]!, gemini = peers[2]![index]!;
    assert.equal((await call(claude, 'relay_status')).self.projectId, projectId);
    await call(claude, 'relay_send', { body: `Only ${projectId}`, dedupeKey: 'same-key' });
    await call(claude, 'relay_put_note', { key: 'contract', content: projectId, expectedRevision: 0 });
    await call(claude, 'relay_claim_files', { paths: ['src/api.ts'] });
    const task = await call(claude, 'relay_create_task', { title: 'Review', description: projectId });
    const claim = await call(claude, 'relay_claim_task', { taskId: task.id });
    await call(claude, 'relay_handoff', { taskId: task.id, leaseToken: claim.leaseToken, to: 'deepseek', summary: projectId });
    const inbox = await call(deepseek, 'relay_inbox');
    assert.equal(inbox.messages.length, 2);
    assert.ok(inbox.messages.every((message: any) => message.projectId === projectId));
    assert.deepEqual((await call(gemini, 'relay_inbox')).messages.map((message: any) => message.body), [`Only ${projectId}`]);
    assert.equal((await call(gemini, 'relay_notes')).notes[0].content, projectId);
    assert.equal((await call(deepseek, 'relay_tasks')).tasks.length, 1);
    await call(deepseek, 'relay_claim_task', { taskId: task.id });
    await call(deepseek, 'relay_ack', { messageIds: inbox.messages.map((message: any) => message.id) });
    assert.equal((await call(deepseek, 'relay_inbox')).messages.length, 0);
  }));
});

test('one HTTP endpoint routes simultaneous projects by credentials, not agent names', async t => {
  const f = fixture(t);
  const http = await startHttp(f.store, 0);
  const request = async (identity: Identity, tool: string, input = {}) => {
    const result = await fetch(`${http.url}/v1/tools/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: result.status, body: await result.json() as any };
  };
  try {
    const messages = await Promise.all(f.groups.map(async group => {
      const [sender, recipient] = group.identities as [Identity, Identity];
      const sent = await request(sender, 'relay_send', { to: recipient.agentId, body: group.project.id });
      assert.equal(sent.status, 200);
      return sent.body.data;
    }));
    for (const [index, group] of f.groups.entries()) {
      const recipient = group.identities[1]!;
      const inbox = await request(recipient, 'relay_inbox');
      assert.deepEqual(inbox.body.data.messages.map((message: any) => message.id), [messages[index].id]);
      assert.equal((await request(recipient, 'relay_ack', { messageIds: [messages[1 - index].id] })).status, 404);
      assert.equal((await request(recipient, 'relay_inbox', { projectId: f.groups[1 - index]!.project.id })).status, 400);
    }
  } finally { await http.close(); }
});

test('CLI lists projects and generates only explicitly selected project connections', { timeout: 25_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-project-cli-'));
  const state = join(directory, 'state');
  const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: directory })).stdout);
  try {
    assert.deepEqual((await run('projects', '--state', state)).projects, []);
    assert.equal(existsSync(state), false, 'listing an empty state does not initialize a database');
    const projects = [];
    for (const label of ['a', 'b', 'not-selected']) {
      const root = join(directory, label, 'same-name'); mkdirSync(root, { recursive: true });
      projects.push(await run('init', '--project', root, '--state', state));
    }
    const again = await run('init', '--project', join(directory, 'a/same-name'), '--state', state);
    assert.equal(again.project.id, projects[0].project.id);
    const listed = (await run('projects', '--state', state)).projects;
    assert.equal(listed.length, 3);
    assert.ok(listed.every((project: any) => project.activeAgents === 3));
    const selected = projects.slice(0, 2).map(project => project.project.id);
    for (const format of ['claude', 'antigravity', 'vscode', 'generic']) {
      const config = await run('config', '--agent', 'deepseek', '--projects', selected.join(','), '--state', state, '--format', format);
      const entries = config[format === 'vscode' ? 'servers' : 'mcpServers'];
      assert.equal(Object.keys(entries).length, 2);
      assert.doesNotMatch(JSON.stringify(config), new RegExp(projects[2].project.id));
      assert.doesNotMatch(JSON.stringify(config), /pr_[A-Za-z0-9_-]{40}/);
      for (const [index, entry] of (Object.values(entries) as any[]).entries()) {
        assert.equal(resolve(entry.args[3]), entry.args[3]);
        const status = await run('call', '--identity', entry.args[3], '--tool', 'relay_status');
        assert.equal(status.data.self.projectId, selected[index]);
        assert.equal(status.data.self.agentId, 'deepseek');
      }
    }
    for (const ids of ['', '../../bad', `${selected[0]},${selected[0]}`, '00000000-0000-4000-8000-000000000000']) {
      await assert.rejects(run('config', '--agent', 'deepseek', '--projects', ids, '--state', state));
    }
    await assert.rejects(run('config', '--agent', '../deepseek', '--projects', selected.join(','), '--state', state));
    await assert.rejects(run('config', '--agent', 'missing', '--projects', selected.join(','), '--state', state));
    await assert.rejects(run('config', '--identity', projects[0].connections[0].identityFile, '--agent', 'deepseek', '--projects', selected.join(',')));
    const store = new Store(join(state, 'relay.sqlite'));
    try { store.revoke(selected[0], 'deepseek'); } finally { store.close(); }
    await assert.rejects(run('config', '--agent', 'deepseek', '--projects', selected.join(','), '--state', state));
    assert.equal(Object.keys((await run('config', '--agent', 'deepseek', '--projects', selected[1], '--state', state)).mcpServers).length, 1);
    copyFileSync(projects[1].connections[0].identityFile, projects[0].connections[0].identityFile);
    await assert.rejects(run('config', '--agent', 'claude-vscode', '--projects', selected[0], '--state', state));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('project identifiers with identical short prefixes cannot overwrite an MCP entry', () => {
  const ids = ['aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-2222-4222-8222-222222222222'];
  const entries = Object.assign({}, ...ids.map(id => clientConfig(`/example/${id}.identity.json`, id, 'generic').mcpServers));
  assert.equal(Object.keys(entries).length, 2);
  assert.deepEqual(Object.values(entries).map((entry: any) => entry.args[3]), ids.map(id => `/example/${id}.identity.json`));
});
