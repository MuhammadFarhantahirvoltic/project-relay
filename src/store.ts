import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RelayError, requireThat } from './errors.js';

export const PROTOCOL_VERSION = '1.0';
export interface Actor { projectId: string; agentId: string }
export interface Identity extends Actor { protocolVersion: string; token: string; database: string }
// SQL rows are converted to JSON at the API boundary; SQLite never stores arbitrary JS objects.
type Row = Record<string, any>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const slug = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizePath(input: string): string {
  requireThat(input.length > 0 && input.length <= 500 && !/[\\\u0000-\u001f:*?]/.test(input), 'INVALID_PATH', 'Use a literal project-relative path with forward slashes.');
  requireThat(!input.startsWith('/'), 'INVALID_PATH', 'Absolute paths are not allowed.');
  const pieces = input.split('/').filter(p => p !== '' && p !== '.');
  requireThat(pieces.length && !pieces.includes('..'), 'INVALID_PATH', 'Parent traversal and root-wide claims are not allowed.');
  return pieces.join('/').normalize('NFC');
}

function publicRow(row: Row): Row {
  return Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['token_hash', 'lease_token', 'dedupe_payload'].includes(key))
    .map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
}

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(readonly database: string, private readonly now: () => number = Date.now) {
    if (database !== ':memory:') {
      mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
      try { writeFileSync(database, '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      // Set permissions before SQLite creates WAL/SHM sidecars, which inherit them.
      chmodSync(database, 0o600);
    }
    this.db = new DatabaseSync(database);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.one('PRAGMA user_version')!.user_version;
    requireThat(version <= 1, 'DATABASE_VERSION', 'This database requires a newer Project Relay version.');
    this.tx(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
          project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, harness TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '[]',
          checkout TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
          last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, created_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, id)
        );
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id), sender TEXT NOT NULL, recipient TEXT,
          kind TEXT NOT NULL, topic TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT,
          dedupe_key TEXT, dedupe_payload TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(project_id, sender, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS messages_inbox ON messages(project_id, seq);
        CREATE TABLE IF NOT EXISTS receipts (
          message_id TEXT NOT NULL REFERENCES messages(id), agent_id TEXT NOT NULL,
          acked_at INTEGER NOT NULL, PRIMARY KEY(message_id, agent_id)
        );
        CREATE TABLE IF NOT EXISTS notes (
          project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL,
          content TEXT NOT NULL, revision INTEGER NOT NULL, updated_by TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(project_id, key)
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
          description TEXT NOT NULL, created_by TEXT NOT NULL, assignee TEXT, owner TEXT,
          state TEXT NOT NULL, lease_token TEXT, lease_expires_at INTEGER,
          summary TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
          dedupe_key TEXT, dedupe_payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(project_id, created_by, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, created_at, id);
        CREATE TABLE IF NOT EXISTS file_claims (
          project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, path_key TEXT NOT NULL,
          agent_id TEXT NOT NULL, lease_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, path_key)
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
          actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
          recipient TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);
        PRAGMA user_version=1;
      `);
    });
    if (database !== ':memory:') chmodSync(database, 0o600);
  }
  close() { this.db.close(); }
  private one(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values); }
  private all(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values); }
  private run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  private tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  private event(actor: Actor, kind: string, data: unknown, recipient: string | null = null) {
    this.run('INSERT INTO events(project_id,actor,kind,data,recipient,created_at) VALUES(?,?,?,?,?,?)',
      actor.projectId, actor.agentId, kind, JSON.stringify(data), recipient, this.now());
  }
  private agent(actor: Actor, id: string) {
    const row = this.one('SELECT id FROM agents WHERE project_id=? AND id=? AND revoked_at IS NULL', actor.projectId, id);
    requireThat(row, 'AGENT_NOT_FOUND', 'Agent is not an active member of this project.', 404);
  }
  createProject(root: string, name: string) {
    return this.tx(() => {
      const existing = this.one('SELECT * FROM projects WHERE root=?', root);
      if (existing) return publicRow(existing);
      const id = randomUUID();
      this.run('INSERT INTO projects VALUES(?,?,?,?)', id, root, name, this.now());
      return publicRow(this.one('SELECT * FROM projects WHERE id=?', id)!);
    });
  }
  issueIdentity(projectId: string, agentId: string, rotate = false): Identity {
    requireThat(slug.test(agentId), 'INVALID_AGENT', 'Agent IDs must use lowercase letters, digits, dots, underscores, or hyphens (1–64 characters).');
    requireThat(this.one('SELECT id FROM projects WHERE id=?', projectId), 'PROJECT_NOT_FOUND', 'Unknown project.', 404);
    return this.tx(() => {
      const exists = this.one('SELECT id FROM agents WHERE project_id=? AND id=?', projectId, agentId);
      requireThat(!exists || rotate, 'AGENT_EXISTS', 'Agent already exists. Reuse its identity file or explicitly rotate its credential.', 409);
      const token = `pr_${randomBytes(32).toString('base64url')}`;
      if (exists) {
        this.run('UPDATE agents SET token_hash=?,revoked_at=NULL WHERE project_id=? AND id=?', hash(token), projectId, agentId);
        this.releaseAgentWork({ projectId, agentId });
      } else {
        this.run('INSERT INTO agents(project_id,id,token_hash,label,created_at) VALUES(?,?,?,?,?)', projectId, agentId, hash(token), agentId, this.now());
      }
      this.event({ projectId, agentId }, exists ? 'agent.rotated' : 'agent.joined', { agentId });
      return { protocolVersion: PROTOCOL_VERSION, projectId, agentId, token, database: this.database };
    });
  }
  revoke(projectId: string, agentId: string) {
    return this.tx(() => {
      this.agent({ projectId, agentId }, agentId);
      this.run('UPDATE agents SET revoked_at=? WHERE project_id=? AND id=?', this.now(), projectId, agentId);
      this.releaseAgentWork({ projectId, agentId });
      this.event({ projectId, agentId }, 'agent.revoked', { agentId });
      return { revoked: agentId };
    });
  }
  private releaseAgentWork(actor: Actor) {
    this.run('DELETE FROM file_claims WHERE project_id=? AND agent_id=?', actor.projectId, actor.agentId);
    this.run(`UPDATE tasks SET owner=NULL,lease_token=NULL,lease_expires_at=NULL,state='open',revision=revision+1,updated_at=?
      WHERE project_id=? AND owner=? AND state IN ('in_progress','blocked')`, this.now(), actor.projectId, actor.agentId);
    this.run(`UPDATE tasks SET assignee=NULL,revision=revision+1,updated_at=?
      WHERE project_id=? AND assignee=? AND state IN ('open','in_progress','blocked')`, this.now(), actor.projectId, actor.agentId);
  }
  authenticate(token: string): Actor {
    requireThat(typeof token === 'string' && token.length >= 40 && token.length <= 200, 'UNAUTHORIZED', 'A valid Project Relay credential is required.', 401);
    const row = this.one('SELECT project_id,id FROM agents WHERE token_hash=? AND revoked_at IS NULL', hash(token));
    requireThat(row, 'UNAUTHORIZED', 'Credential is invalid or revoked.', 401);
    return { projectId: row.project_id, agentId: row.id };
  }
  status(actor: Actor) {
    const agents = this.all('SELECT * FROM agents WHERE project_id=? ORDER BY id', actor.projectId).map(row => ({
      ...publicRow(row), capabilities: JSON.parse(row.capabilities),
      online: row.revoked_at === null && row.last_seen > this.now() - 120_000,
    }));
    const unread = this.one(`SELECT count(*) AS count FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.agent_id=?
      WHERE m.project_id=? AND m.sender<>? AND (m.recipient IS NULL OR m.recipient=?) AND r.message_id IS NULL`,
      actor.agentId, actor.projectId, actor.agentId, actor.agentId)!.count;
    return { protocolVersion: PROTOCOL_VERSION, self: actor, project: publicRow(this.one('SELECT * FROM projects WHERE id=?', actor.projectId)!), agents, unread };
  }
  heartbeat(actor: Actor, input: { label?: string; harness?: string; model?: string; capabilities?: string[]; checkout?: string; branch?: string }) {
    const row = this.one('SELECT * FROM agents WHERE project_id=? AND id=?', actor.projectId, actor.agentId)!;
    this.run('UPDATE agents SET label=?,harness=?,model=?,capabilities=?,checkout=?,branch=?,last_seen=? WHERE project_id=? AND id=?',
      input.label ?? row.label, input.harness ?? row.harness, input.model ?? row.model,
      input.capabilities ? JSON.stringify(input.capabilities) : row.capabilities, input.checkout ?? row.checkout,
      input.branch ?? row.branch, this.now(), actor.projectId, actor.agentId);
    return { ...actor, lastSeen: this.now(), onlineForSeconds: 120 };
  }
  send(actor: Actor, input: { to?: string; kind: string; topic: string; body: string; replyTo?: string; dedupeKey?: string }): Row {
    return this.tx(() => {
      if (input.to) this.agent(actor, input.to);
      if (input.replyTo) {
        requireThat(this.one(`SELECT id FROM messages WHERE project_id=? AND id=? AND (recipient IS NULL OR recipient=? OR sender=?)`,
          actor.projectId, input.replyTo, actor.agentId, actor.agentId), 'MESSAGE_NOT_FOUND', 'Reply target is not visible to this agent.', 404);
      }
      const payload = JSON.stringify({ to: input.to ?? null, kind: input.kind, topic: input.topic, body: input.body, replyTo: input.replyTo ?? null });
      if (input.dedupeKey) {
        const existing = this.one('SELECT * FROM messages WHERE project_id=? AND sender=? AND dedupe_key=?', actor.projectId, actor.agentId, input.dedupeKey);
        if (existing) {
          requireThat(existing.dedupe_payload === payload, 'IDEMPOTENCY_CONFLICT', 'This dedupe key was used for different content.', 409);
          return { ...publicRow(existing), duplicate: true };
        }
      }
      const id = randomUUID();
      this.run(`INSERT INTO messages(id,project_id,sender,recipient,kind,topic,body,reply_to,dedupe_key,dedupe_payload,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, actor.projectId, actor.agentId, input.to ?? null, input.kind, input.topic, input.body,
        input.replyTo ?? null, input.dedupeKey ?? null, payload, this.now());
      this.event(actor, 'message.sent', { messageId: id, kind: input.kind }, input.to ?? null);
      return { ...publicRow(this.one('SELECT * FROM messages WHERE id=?', id)!), duplicate: false };
    });
  }
  inbox(actor: Actor, input: { after: number; limit: number; includeAcked: boolean }) {
    const rows = this.all(`SELECT m.*,r.acked_at FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.agent_id=?
      WHERE m.project_id=? AND m.sender<>? AND (m.recipient IS NULL OR m.recipient=?) AND m.seq>?
      AND (?=1 OR r.message_id IS NULL) ORDER BY m.seq LIMIT ?`,
      actor.agentId, actor.projectId, actor.agentId, actor.agentId, input.after, Number(input.includeAcked), input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { messages: page.map(publicRow), nextCursor: page.at(-1)?.seq ?? input.after, hasMore: rows.length > input.limit };
  }
  acknowledge(actor: Actor, ids: string[]) {
    return this.tx(() => {
      for (const id of ids) {
        requireThat(this.one(`SELECT id FROM messages WHERE id=? AND project_id=? AND sender<>? AND (recipient IS NULL OR recipient=?)`,
          id, actor.projectId, actor.agentId, actor.agentId), 'MESSAGE_NOT_FOUND', 'Message is not in this agent’s inbox.', 404);
      }
      for (const id of ids) this.run('INSERT OR IGNORE INTO receipts VALUES(?,?,?)', id, actor.agentId, this.now());
      return { acknowledged: ids };
    });
  }
  notes(actor: Actor, input: { key?: string; after: string; limit: number }) {
    if (input.key) {
      const row = this.one('SELECT * FROM notes WHERE project_id=? AND key=?', actor.projectId, input.key);
      return { notes: row ? [publicRow(row)] : [], nextCursor: input.after, hasMore: false };
    }
    const rows = this.all('SELECT * FROM notes WHERE project_id=? AND key>? ORDER BY key LIMIT ?', actor.projectId, input.after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { notes: page.map(publicRow), nextCursor: page.at(-1)?.key ?? input.after, hasMore: rows.length > input.limit };
  }
  putNote(actor: Actor, input: { key: string; content: string; expectedRevision: number }) {
    return this.tx(() => {
      const current = this.one('SELECT revision FROM notes WHERE project_id=? AND key=?', actor.projectId, input.key);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new RelayError('REVISION_CONFLICT', 'Read the current note before updating it.', 409, { currentRevision: current?.revision ?? 0 });
      this.run(`INSERT INTO notes VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET
        content=excluded.content,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
        actor.projectId, input.key, input.content, input.expectedRevision + 1, actor.agentId, this.now());
      this.event(actor, 'note.updated', { key: input.key, revision: input.expectedRevision + 1 });
      return publicRow(this.one('SELECT * FROM notes WHERE project_id=? AND key=?', actor.projectId, input.key)!);
    });
  }
  createTask(actor: Actor, input: { title: string; description: string; assignee?: string; dedupeKey?: string }) {
    return this.tx(() => {
      if (input.assignee) this.agent(actor, input.assignee);
      const payload = JSON.stringify({ title: input.title, description: input.description, assignee: input.assignee ?? null });
      if (input.dedupeKey) {
        const existing = this.one('SELECT * FROM tasks WHERE project_id=? AND created_by=? AND dedupe_key=?', actor.projectId, actor.agentId, input.dedupeKey);
        if (existing) {
          requireThat(existing.dedupe_payload === payload, 'IDEMPOTENCY_CONFLICT', 'This dedupe key was used for a different task.', 409);
          return { ...publicRow(existing), duplicate: true };
        }
      }
      const id = randomUUID();
      this.run(`INSERT INTO tasks(id,project_id,title,description,created_by,assignee,state,dedupe_key,dedupe_payload,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'open',?,?,?,?)`, id, actor.projectId, input.title, input.description, actor.agentId, input.assignee ?? null,
        input.dedupeKey ?? null, payload, this.now(), this.now());
      this.event(actor, 'task.created', { taskId: id, assignee: input.assignee ?? null });
      return { ...publicRow(this.task(actor, id)), duplicate: false };
    });
  }
  private task(actor: Actor, id: string) {
    const row = this.one('SELECT * FROM tasks WHERE project_id=? AND id=?', actor.projectId, id);
    requireThat(row, 'TASK_NOT_FOUND', 'Unknown task in this project.', 404);
    return row;
  }
  tasks(actor: Actor, input: { taskId?: string; state?: string; after: string; limit: number }) {
    if (input.taskId) return { tasks: [publicRow(this.task(actor, input.taskId))], nextCursor: input.after, hasMore: false };
    const rows = this.all('SELECT * FROM tasks WHERE project_id=? AND (? IS NULL OR state=?) AND id>? ORDER BY id LIMIT ?',
      actor.projectId, input.state ?? null, input.state ?? null, input.after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { tasks: page.map(publicRow), nextCursor: page.at(-1)?.id ?? input.after, hasMore: rows.length > input.limit };
  }
  claimTask(actor: Actor, input: { taskId: string; ttlSeconds: number }) {
    return this.tx(() => {
      const row = this.task(actor, input.taskId);
      requireThat(!row.assignee || row.assignee === actor.agentId, 'TASK_ASSIGNED', 'This task is assigned to another agent.', 409);
      requireThat(row.state === 'open' || (['in_progress', 'blocked'].includes(row.state) && row.lease_expires_at <= this.now()), 'TASK_UNAVAILABLE', 'Task is complete or has an active owner. Renew an existing lease using task_update.', 409);
      const leaseToken = randomUUID();
      this.run(`UPDATE tasks SET state='in_progress',owner=?,lease_token=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE id=?`,
        actor.agentId, leaseToken, this.now() + input.ttlSeconds * 1000, this.now(), row.id);
      this.event(actor, 'task.claimed', { taskId: row.id });
      return { ...publicRow(this.task(actor, row.id)), leaseToken };
    });
  }
  private ownedTask(actor: Actor, taskId: string, leaseToken: string) {
    const row = this.task(actor, taskId);
    requireThat(row.owner === actor.agentId && row.lease_token === leaseToken && row.lease_expires_at > this.now() && ['in_progress', 'blocked'].includes(row.state),
      'LEASE_LOST', 'Task lease expired or no longer belongs to this agent. Stop work and claim again.', 409);
    return row;
  }
  updateTask(actor: Actor, input: { taskId: string; leaseToken: string; state?: string; summary?: string; ttlSeconds: number }) {
    return this.tx(() => {
      const row = this.ownedTask(actor, input.taskId, input.leaseToken);
      const state = input.state ?? row.state;
      const final = ['done', 'cancelled'].includes(state);
      this.run(`UPDATE tasks SET state=?,summary=?,lease_token=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE id=?`,
        state, input.summary ?? row.summary, final ? null : input.leaseToken, final ? null : this.now() + input.ttlSeconds * 1000, this.now(), row.id);
      this.event(actor, 'task.updated', { taskId: row.id, state });
      return publicRow(this.task(actor, row.id));
    });
  }
  handoffTask(actor: Actor, input: { taskId: string; leaseToken: string; to: string; summary: string }) {
    return this.tx(() => {
      const row = this.ownedTask(actor, input.taskId, input.leaseToken);
      this.agent(actor, input.to);
      requireThat(input.to !== actor.agentId, 'INVALID_HANDOFF', 'Hand off to a different agent.');
      this.run(`UPDATE tasks SET state='open',assignee=?,owner=NULL,lease_token=NULL,lease_expires_at=NULL,summary=?,revision=revision+1,updated_at=? WHERE id=?`,
        input.to, input.summary, this.now(), row.id);
      const message = this.send(actor, { to: input.to, kind: 'handoff', topic: row.title, body: JSON.stringify({ taskId: row.id, summary: input.summary }) });
      this.event(actor, 'task.handed_off', { taskId: row.id, to: input.to });
      return { task: publicRow(this.task(actor, row.id)), messageId: message.id };
    });
  }
  fileClaims(actor: Actor) {
    return { claims: this.all('SELECT * FROM file_claims WHERE project_id=? AND expires_at>? ORDER BY path_key', actor.projectId, this.now()).map(publicRow) };
  }
  claimFiles(actor: Actor, input: { paths: string[]; ttlSeconds: number }) {
    return this.tx(() => {
      const paths = input.paths.map(normalizePath);
      const keys = paths.map(p => p.toLowerCase());
      const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
        requireThat(!overlaps(keys[i]!, keys[j]!), 'OVERLAPPING_PATHS', 'Remove duplicate or overlapping paths from this request.');
      }
      const active = this.all('SELECT * FROM file_claims WHERE project_id=? AND expires_at>?', actor.projectId, this.now());
      const conflicts = active.filter(row => keys.some(key => overlaps(key, row.path_key)));
      if (conflicts.length) throw new RelayError('FILE_CONFLICT', 'Another active claim overlaps these paths. Coordinate or wait for its lease to expire.', 409, { conflicts: conflicts.map(publicRow) });
      const expiresAt = this.now() + input.ttlSeconds * 1000;
      const claims = paths.map((path, index) => {
        const leaseToken = randomUUID();
        this.run(`INSERT INTO file_claims VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,path_key) DO UPDATE SET
          path=excluded.path,agent_id=excluded.agent_id,lease_token=excluded.lease_token,expires_at=excluded.expires_at`,
          actor.projectId, path, keys[index]!, actor.agentId, leaseToken, expiresAt);
        return { path, leaseToken, expiresAt };
      });
      this.event(actor, 'files.claimed', { paths, expiresAt });
      return { claims, advisory: true };
    });
  }
  changeFiles(actor: Actor, input: { claims: { path: string; leaseToken: string }[]; ttlSeconds?: number }, release: boolean) {
    return this.tx(() => {
      const keys = input.claims.map(claim => normalizePath(claim.path).toLowerCase());
      for (const [index, key] of keys.entries()) {
        const row = this.one('SELECT * FROM file_claims WHERE project_id=? AND path_key=?', actor.projectId, key);
        requireThat(row && row.agent_id === actor.agentId && row.lease_token === input.claims[index]!.leaseToken && row.expires_at > this.now(),
          'LEASE_LOST', 'A file claim expired or no longer belongs to this agent.', 409);
      }
      const expiresAt = this.now() + (input.ttlSeconds ?? 900) * 1000;
      for (const key of keys) {
        if (release) this.run('DELETE FROM file_claims WHERE project_id=? AND path_key=?', actor.projectId, key);
        else this.run('UPDATE file_claims SET expires_at=? WHERE project_id=? AND path_key=?', expiresAt, actor.projectId, key);
      }
      this.event(actor, release ? 'files.released' : 'files.renewed', { paths: input.claims.map(c => c.path) });
      return { paths: input.claims.map(c => c.path), ...(release ? { released: true } : { expiresAt }) };
    });
  }
  events(actor: Actor, input: { after: number; limit: number }) {
    const rows = this.all('SELECT * FROM events WHERE project_id=? AND seq>? AND (recipient IS NULL OR recipient=? OR actor=?) ORDER BY seq LIMIT ?',
      actor.projectId, input.after, actor.agentId, actor.agentId, input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { events: page.map(row => ({ ...publicRow(row), data: JSON.parse(row.data) })), nextCursor: page.at(-1)?.seq ?? input.after, hasMore: rows.length > input.limit };
  }
}
