import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { PROTOCOL_VERSION, Store, type Identity } from './store.js';
import { requireThat } from './errors.js';

const identitySchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), projectId: z.string().uuid(), agentId: z.string().min(1).max(64),
  token: z.string().min(40).max(200), database: z.string().min(1),
});
export function readIdentity(path: string): Identity {
  const parsed = identitySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  requireThat(parsed.success, 'INVALID_IDENTITY', 'Identity file is not valid Project Relay v1 JSON.');
  requireThat(resolve(parsed.data.database) === parsed.data.database, 'INVALID_IDENTITY', 'Identity database path must be absolute.');
  return parsed.data;
}
export function openIdentity(path: string) {
  const identity = readIdentity(path);
  requireThat(existsSync(identity.database), 'DATABASE_MISSING', 'Identity database is missing. Check its absolute path.');
  const store = new Store(identity.database);
  try {
    const actor = store.authenticate(identity.token);
    requireThat(actor.projectId === identity.projectId && actor.agentId === identity.agentId, 'IDENTITY_MISMATCH', 'Identity metadata does not match its credential.');
    return { store, identity };
  } catch (error) { store.close(); throw error; }
}
export function privateWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
export function identityPath(state: string, projectId: string, agentId: string) {
  return join(state, 'identities', projectId, `${agentId}.identity.json`);
}
export function clientConfig(identityFile: string, projectId: string, format: string) {
  requireThat(['claude', 'antigravity', 'vscode', 'generic'].includes(format), 'INVALID_FORMAT', 'Format must be claude, antigravity, vscode, or generic.');
  const entry = {
    ...(format === 'vscode' || format === 'claude' ? { type: 'stdio' } : {}),
    command: process.execPath,
    args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp', '--identity', resolve(identityFile)],
  };
  // Keep the full UUID while leaving room for host-qualified tool names.
  return { [format === 'vscode' ? 'servers' : 'mcpServers']: { [`relay-${projectId.replaceAll('-', '')}`]: entry } };
}

export function projectConfigs(state: string, agentId: string, projectIds: string[], format: string) {
  requireThat(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentId), 'INVALID_AGENT', 'Provide a valid agent ID.');
  requireThat(projectIds.length > 0 && projectIds.length <= 100 && new Set(projectIds).size === projectIds.length
    && projectIds.every(id => z.string().uuid().safeParse(id).success),
  'INVALID_PROJECTS', 'Provide 1–100 distinct project UUIDs from the projects command.');
  const entries: Record<string, unknown> = {};
  for (const projectId of projectIds) {
    const path = identityPath(state, projectId, agentId);
    requireThat(existsSync(path), 'IDENTITY_MISSING', 'The agent needs an identity in every selected project. Run init or agent-add first.');
    const { store, identity } = openIdentity(path);
    try {
      requireThat(identity.projectId === projectId && identity.agentId === agentId && identity.database === join(resolve(state), 'relay.sqlite'),
        'IDENTITY_MISMATCH', 'An identity file does not match the selected project, agent, or state directory.');
      Object.assign(entries, Object.values(clientConfig(path, projectId, format))[0]);
    } finally { store.close(); }
  }
  return { [format === 'vscode' ? 'servers' : 'mcpServers']: entries };
}
