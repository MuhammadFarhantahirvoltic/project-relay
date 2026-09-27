import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, normalizePath, type Identity } from '../store.js';
import { dispatch } from '../tools.js';
import { RelayError } from '../errors.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-core-'));
  let now = 1_000_000;
  const store = new Store(join(directory, 'relay.sqlite'), () => now);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.createProject('/project/one', 'One');
  const otherProject = store.createProject('/project/two', 'Two');
  const a = store.issueIdentity(project.id, 'claude');
  const b = store.issueIdentity(project.id, 'deepseek');
  const c = store.issueIdentity(project.id, 'gemini');
  const stranger = store.issueIdentity(otherProject.id, 'deepseek');
  const call = async (who: Identity, name: string, input: unknown = {}) => (await dispatch(store, who.token, name, input)).data as any;
  return { store, a, b, c, stranger, call, advance: (ms: number) => { now += ms; } };
}
const code = (expected: string) => (error: unknown) => error instanceof RelayError && error.code === expected;

test('credentials bind project and sender; schemas reject impersonation', async t => {
  const f = fixture(t);
  await assert.rejects(dispatch(f.store, 'bad-token', 'relay_status', {}), code('UNAUTHORIZED'));
  await assert.rejects(f.call(f.a, 'relay_send', { body: 'hello', sender: 'gemini' }), code('INVALID_INPUT'));
  await assert.rejects(f.call(f.a, 'relay_status', { projectId: f.stranger.projectId }), code('INVALID_INPUT'));
  const status = await f.call(f.a, 'relay_status');
  assert.equal(status.self.agentId, 'claude');
  assert.equal(status.agents.length, 3);
  assert.doesNotMatch(JSON.stringify(status), /token|leaseToken/);
  await f.call(f.a, 'relay_send', { to: 'deepseek', body: 'project one only' });
  assert.equal((await f.call(f.stranger, 'relay_inbox')).messages.length, 0);
});

test('direct messages, broadcasts, idempotency, and per-recipient acknowledgements', async t => {
  const f = fixture(t);
  const input = { to: 'deepseek', body: 'Review API', dedupeKey: 'api-review-1' };
  const direct = await f.call(f.a, 'relay_send', input);
  const duplicate = await f.call(f.a, 'relay_send', input);
  assert.equal(duplicate.id, direct.id); assert.equal(duplicate.duplicate, true);
  await assert.rejects(f.call(f.a, 'relay_send', { ...input, body: 'Changed' }), code('IDEMPOTENCY_CONFLICT'));
  const broadcast = await f.call(f.a, 'relay_send', { body: 'Build is ready' });
  assert.deepEqual((await f.call(f.b, 'relay_inbox')).messages.map((m: any) => m.id), [direct.id, broadcast.id]);
  assert.deepEqual((await f.call(f.c, 'relay_inbox')).messages.map((m: any) => m.id), [broadcast.id]);
  await assert.rejects(f.call(f.c, 'relay_ack', { messageIds: [broadcast.id, direct.id] }), code('MESSAGE_NOT_FOUND'));
  assert.equal((await f.call(f.c, 'relay_inbox')).messages.length, 1, 'failed ack batch is atomic');
  await f.call(f.b, 'relay_ack', { messageIds: [direct.id, broadcast.id] });
  await f.call(f.b, 'relay_ack', { messageIds: [direct.id] });
  assert.equal((await f.call(f.b, 'relay_inbox')).messages.length, 0);
  assert.equal((await f.call(f.c, 'relay_inbox')).messages.length, 1);
  assert.equal((await f.call(f.b, 'relay_inbox', { includeAcked: true })).messages.length, 2);
});

test('message pagination and private event visibility preserve unread delivery', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) await f.call(f.a, 'relay_send', { to: 'deepseek', body: `message ${i}` });
  const first = await f.call(f.b, 'relay_inbox', { limit: 2 });
  const second = await f.call(f.b, 'relay_inbox', { limit: 2, after: first.nextCursor });
  const third = await f.call(f.b, 'relay_inbox', { limit: 2, after: second.nextCursor });
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, true); assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.messages, ...second.messages, ...third.messages].map(m => m.id)).size, 5);
  assert.equal((await f.call(f.b, 'relay_inbox')).messages.length, 5, 'reading never acknowledges');
  assert.equal((await f.call(f.c, 'relay_events')).events.filter((e: any) => e.kind === 'message.sent').length, 0);
  assert.equal((await f.call(f.a, 'relay_events')).events.filter((e: any) => e.kind === 'message.sent').length, 5);
  await assert.rejects(f.call(f.c, 'relay_send', { body: 'Cannot reply', replyTo: first.messages[0].id }), code('MESSAGE_NOT_FOUND'));
});

test('shared notes use compare-and-swap revisions and paginate without overwrites', async t => {
  const f = fixture(t);
  await f.call(f.a, 'relay_put_note', { key: 'architecture', content: 'Use SQLite', expectedRevision: 0 });
  await assert.rejects(f.call(f.b, 'relay_put_note', { key: 'architecture', content: 'Stale update', expectedRevision: 0 }), code('REVISION_CONFLICT'));
  const updated = await f.call(f.b, 'relay_put_note', { key: 'architecture', content: 'SQLite with WAL', expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal((await f.call(f.stranger, 'relay_notes')).notes.length, 0);
  await f.call(f.c, 'relay_put_note', { key: 'tests', content: 'All pass', expectedRevision: 0 });
  const page = await f.call(f.a, 'relay_notes', { limit: 1 });
  assert.equal(page.hasMore, true);
  assert.equal((await f.call(f.a, 'relay_notes', { after: page.nextCursor, limit: 1 })).notes[0].key, 'tests');
});

test('task ownership is exclusive, expires, and fences stale workers', async t => {
  const f = fixture(t);
  const created = await f.call(f.a, 'relay_create_task', { title: 'Review', description: 'Review API', dedupeKey: 'review' });
  const again = await f.call(f.a, 'relay_create_task', { title: 'Review', description: 'Review API', dedupeKey: 'review' });
  assert.equal(created.id, again.id);
  const first = await f.call(f.a, 'relay_claim_task', { taskId: created.id, ttlSeconds: 30 });
  await assert.rejects(f.call(f.b, 'relay_claim_task', { taskId: created.id }), code('TASK_UNAVAILABLE'));
  await assert.rejects(f.call(f.b, 'relay_update_task', { taskId: created.id, leaseToken: first.leaseToken, state: 'done' }), code('LEASE_LOST'));
  f.advance(30_001);
  const reclaimed = await f.call(f.b, 'relay_claim_task', { taskId: created.id });
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  await assert.rejects(f.call(f.a, 'relay_update_task', { taskId: created.id, leaseToken: first.leaseToken, state: 'done' }), code('LEASE_LOST'));
  assert.doesNotMatch(JSON.stringify(await f.call(f.c, 'relay_tasks')), /leaseToken/);
  await f.call(f.b, 'relay_update_task', { taskId: created.id, leaseToken: reclaimed.leaseToken, state: 'done', summary: 'Checked API tests' });
  await assert.rejects(f.call(f.c, 'relay_claim_task', { taskId: created.id }), code('TASK_UNAVAILABLE'));
  await assert.rejects(f.call(f.stranger, 'relay_tasks', { taskId: created.id }), code('TASK_NOT_FOUND'));
});

test('handoff moves ownership and enqueues context in one transaction', async t => {
  const f = fixture(t);
  const task = await f.call(f.a, 'relay_create_task', { title: 'Finish tests', description: 'API needs tests' });
  const owner = await f.call(f.a, 'relay_claim_task', { taskId: task.id });
  await assert.rejects(f.call(f.a, 'relay_handoff', { taskId: task.id, leaseToken: owner.leaseToken, to: 'absent', summary: 'context' }), code('AGENT_NOT_FOUND'));
  assert.equal((await f.call(f.a, 'relay_tasks', { taskId: task.id })).tasks[0].owner, 'claude');
  const result = await f.call(f.a, 'relay_handoff', { taskId: task.id, leaseToken: owner.leaseToken, to: 'deepseek', summary: 'Branch feature/api, tests needed' });
  assert.equal(result.task.assignee, 'deepseek'); assert.equal(result.task.owner, null);
  const inbox = await f.call(f.b, 'relay_inbox');
  assert.equal(inbox.messages[0].kind, 'handoff');
  assert.equal(JSON.parse(inbox.messages[0].body).taskId, task.id);
  await assert.rejects(f.call(f.c, 'relay_claim_task', { taskId: task.id }), code('TASK_ASSIGNED'));
  await f.call(f.b, 'relay_claim_task', { taskId: task.id });
  await assert.rejects(f.call(f.a, 'relay_handoff', { taskId: task.id, leaseToken: owner.leaseToken, to: 'deepseek', summary: 'repeat' }), code('LEASE_LOST'));
  assert.equal((await f.call(f.b, 'relay_inbox')).messages.length, 1);
});

test('file claims handle overlap, case aliases, atomic batches, expiry, and fencing', async t => {
  const f = fixture(t);
  const a = await f.call(f.a, 'relay_claim_files', { paths: ['src/api'], ttlSeconds: 30 });
  for (const path of ['src/API/users.ts', 'src', 'src/api']) {
    await assert.rejects(f.call(f.b, 'relay_claim_files', { paths: ['README.md', path] }), code('FILE_CONFLICT'));
  }
  assert.equal((await f.call(f.b, 'relay_file_claims')).claims.length, 1, 'conflicting batch claims nothing');
  await f.call(f.b, 'relay_claim_files', { paths: ['src/apix.ts'] });
  await assert.rejects(f.call(f.a, 'relay_claim_files', { paths: ['foo', 'foo/bar'] }), code('OVERLAPPING_PATHS'));
  f.advance(30_001);
  const b = await f.call(f.b, 'relay_claim_files', { paths: ['src/api'] });
  const oldClaims = a.claims.map(({ path, leaseToken }: any) => ({ path, leaseToken }));
  await assert.rejects(f.call(f.a, 'relay_release_files', { claims: oldClaims }), code('LEASE_LOST'));
  const currentClaims = b.claims.map(({ path, leaseToken }: any) => ({ path, leaseToken }));
  await f.call(f.b, 'relay_renew_files', { claims: currentClaims, ttlSeconds: 3600 });
  await f.call(f.b, 'relay_release_files', { claims: currentClaims });
  assert.equal((await f.call(f.a, 'relay_file_claims')).claims.length, 1);
});

test('file claims reject traversal, absolute paths, globs, and Windows aliases', () => {
  for (const path of ['../secret', 'src/../secret', '/tmp/a', '.', '/', 'C:/foo', 'src\\foo', 'src/**', 'foo\u0000bar']) {
    assert.throws(() => normalizePath(path), code('INVALID_PATH'));
  }
  assert.equal(normalizePath('./src//api/'), 'src/api');
});

test('revocation frees owned and assigned work and invalidates existing tokens', async t => {
  const f = fixture(t);
  const task = await f.call(f.a, 'relay_create_task', { title: 'Work', description: 'Assigned', assignee: 'deepseek' });
  await f.call(f.b, 'relay_claim_task', { taskId: task.id });
  await f.call(f.b, 'relay_claim_files', { paths: ['README.md'] });
  f.store.revoke(f.b.projectId, f.b.agentId);
  await assert.rejects(f.call(f.b, 'relay_status'), code('UNAUTHORIZED'));
  const current = (await f.call(f.a, 'relay_tasks', { taskId: task.id })).tasks[0];
  assert.equal(current.state, 'open'); assert.equal(current.assignee, null);
  assert.equal((await f.call(f.a, 'relay_file_claims')).claims.length, 0);
  const newIdentity = f.store.issueIdentity(f.b.projectId, f.b.agentId, true);
  await f.call(newIdentity, 'relay_status');
  await assert.rejects(f.call(f.b, 'relay_status'), code('UNAUTHORIZED'));
});

test('presence expires and malformed requests cannot change state', async t => {
  const f = fixture(t);
  await f.call(f.a, 'relay_heartbeat', { harness: 'VS Code', model: 'Claude', capabilities: ['frontend'] });
  assert.equal((await f.call(f.a, 'relay_status')).agents.find((a: any) => a.id === 'claude').online, true);
  f.advance(120_001);
  assert.equal((await f.call(f.a, 'relay_status')).agents.find((a: any) => a.id === 'claude').online, false);
  for (const input of [{ paths: ['a'], ttlSeconds: 0 }, { paths: [] }, { paths: ['a'], projectId: 'forged' }]) {
    await assert.rejects(f.call(f.a, 'relay_claim_files', input), code('INVALID_INPUT'));
  }
  assert.equal((await f.call(f.a, 'relay_file_claims')).claims.length, 0);
});

test('long polling observes messages and reacts to cancellation and revocation', async t => {
  const f = fixture(t);
  const pending = f.call(f.b, 'relay_inbox', { waitMs: 2000 });
  await f.call(f.a, 'relay_send', { to: 'deepseek', body: 'Wake the waiting poll' });
  assert.equal((await pending).messages.length, 1);
  const abort = new AbortController();
  const cancelled = dispatch(f.store, f.c.token, 'relay_inbox', { waitMs: 2000 }, abort.signal);
  abort.abort(); await assert.rejects(cancelled, code('CANCELLED'));
  const revoked = f.call(f.c, 'relay_inbox', { waitMs: 2000 });
  f.store.revoke(f.c.projectId, f.c.agentId);
  await assert.rejects(revoked, code('UNAUTHORIZED'));
});

test('a second database connection reads persisted messages, notes, and receipts', async t => {
  const f = fixture(t);
  const message = await f.call(f.a, 'relay_send', { to: 'deepseek', body: "Literal ' SQL ; and <script> remain data" });
  await f.call(f.a, 'relay_put_note', { key: 'decision', content: 'Persisted', expectedRevision: 0 });
  const second = new Store(f.store.database);
  try {
    const inbox = (await dispatch(second, f.b.token, 'relay_inbox', {})).data as any;
    assert.equal(inbox.messages[0].id, message.id);
    await dispatch(second, f.b.token, 'relay_ack', { messageIds: [message.id] });
    assert.equal((await f.call(f.b, 'relay_inbox')).messages.length, 0);
    assert.equal(((await dispatch(second, f.b.token, 'relay_notes', {})).data as any).notes[0].content, 'Persisted');
  } finally { second.close(); }
});
