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
  return { [format === 'vscode' ? 'servers' : 'mcpServers']: { [`project-relay-${projectId.slice(0, 8)}`]: entry } };
}
