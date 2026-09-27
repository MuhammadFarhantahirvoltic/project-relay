#!/usr/bin/env node
import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Store } from './store.js';
import { AGENT_INSTRUCTIONS, dispatch, toolCatalog } from './tools.js';
import { createMcpServer } from './mcp.js';
import { startHttp } from './http.js';
import { clientConfig, identityPath, openIdentity, privateWrite, projectConfigs } from './setup.js';
import { errorBody, requireThat } from './errors.js';

const HELP = `Project Relay — shared project coordination for independent agents

  init       --project PATH [--name NAME] [--agents claude-vscode,deepseek,gemini-antigravity] [--state DIR]
  projects   [--state DIR]
  agent-add  --project-id UUID --agent ID [--rotate] [--state DIR]
  revoke     --project-id UUID --agent ID [--state DIR]
  config     --identity FILE [--format claude|antigravity|vscode|generic]
  config     --agent ID --projects UUID,UUID [--format claude|antigravity|vscode|generic] [--state DIR]
  mcp        --identity FILE
  serve      [--state DIR] [--port 7331]
  call       --identity FILE --tool relay_status [--input '{}']
  watch      --identity FILE [--after 0]
  catalog
  demo       Run a scripted three-peer MCP collaboration; no model API calls.

State defaults to ~/.project-relay. Each init creates a project, private identity
files, and ready-to-merge client config fragments. MCP stdio needs no daemon.
serve binds 127.0.0.1 and provides POST /mcp plus /v1/tools for custom harnesses.
Configuration fragments are generated, never silently merged into host settings.
Run init once per repository. Project conversations stay separate, even when
the same agent names share one state directory and HTTP server.
`;
function print(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    project: { type: 'string' }, name: { type: 'string' }, agents: { type: 'string' }, state: { type: 'string' },
    'project-id': { type: 'string' }, projects: { type: 'string' }, agent: { type: 'string' }, identity: { type: 'string' }, format: { type: 'string' },
    port: { type: 'string' }, tool: { type: 'string' }, input: { type: 'string' }, after: { type: 'string' },
    rotate: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (!command || values.help || command === 'help') { process.stdout.write(HELP); return; }
  requireThat(positionals.length === 1, 'INVALID_ARGUMENT', 'Only one command is allowed.');
  const allowed: Record<string, string[]> = {
    init: ['project', 'name', 'agents', 'state'], projects: ['state'], 'agent-add': ['project-id', 'agent', 'rotate', 'state'],
    revoke: ['project-id', 'agent', 'state'], config: ['identity', 'format', 'agent', 'projects', 'state'], mcp: ['identity'],
    serve: ['state', 'port'], call: ['identity', 'tool', 'input'], watch: ['identity', 'after'], catalog: [], demo: [],
  };
  requireThat(allowed[command], 'INVALID_COMMAND', 'Unknown command. Run with --help.');
  for (const option of Object.keys(values)) requireThat(allowed[command]!.includes(option), 'INVALID_ARGUMENT', `--${option} is not valid for ${command}.`);
  const need = (name: keyof typeof values) => {
    const value = values[name]; requireThat(typeof value === 'string' && value, 'MISSING_ARGUMENT', `--${name} is required.`); return value;
  };
  const state = resolve(values.state ?? join(homedir(), '.project-relay'));
  if (command === 'catalog') { print(toolCatalog()); return; }
  if (command === 'demo') { await (await import('./demo.js')).runDemo(); return; }
  if (command === 'projects') {
    const database = join(state, 'relay.sqlite');
    if (!existsSync(database)) { print({ state, projects: [] }); return; }
    const store = new Store(database);
    try { print({ state, projects: store.listProjects() }); }
    finally { store.close(); }
    return;
  }
  if (command === 'config') {
    if (values.identity !== undefined) {
      requireThat(values.agent === undefined && values.projects === undefined && values.state === undefined,
        'INVALID_ARGUMENT', 'Use --identity alone, or select --agent and --projects with optional --state.');
    } else {
      print(projectConfigs(state, need('agent'), need('projects').split(',').map(id => id.trim()), values.format ?? 'generic'));
      return;
    }
  }
  if (command === 'init') {
    const root = realpathSync(resolve(need('project')));
    requireThat(statSync(root).isDirectory(), 'INVALID_PROJECT', 'Project path must be a directory.');
    const agentIds = [...new Set((values.agents ?? 'claude-vscode,deepseek,gemini-antigravity').split(',').map(id => id.trim()))];
    requireThat(agentIds.length > 0 && agentIds.length <= 100 && agentIds.every(id => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)), 'INVALID_AGENTS', 'Provide 1–100 valid, comma-separated agent IDs.');
    const store = new Store(join(state, 'relay.sqlite'));
    try {
      const project = store.createProject(root, values.name ?? basename(root));
      const connections = [];
      for (const agentId of agentIds) {
        const path = identityPath(state, project.id, agentId);
        if (!existsSync(path)) privateWrite(path, store.issueIdentity(project.id, agentId));
        const existing = openIdentity(path);
        try { requireThat(existing.identity.projectId === project.id && existing.identity.database === store.database && existing.identity.agentId === agentId,
          'IDENTITY_MISMATCH', 'An existing identity file belongs to a different project, database, or agent.'); }
        finally { existing.store.close(); }
        const configs: Record<string, string> = {};
        for (const format of ['claude', 'antigravity', 'vscode', 'generic']) {
          const configPath = join(state, 'connections', project.id, `${agentId}.${format}.json`);
          privateWrite(configPath, clientConfig(path, project.id, format));
          configs[format] = configPath;
        }
        connections.push({ agentId, identityFile: path, configs });
      }
      const instructionsPath = join(state, 'connections', project.id, 'AGENT-INSTRUCTIONS.md');
      writeFileSync(instructionsPath, AGENT_INSTRUCTIONS + '\n', { mode: 0o600 });
      print({ project, state, connections, instructionsPath, next: 'Merge each agent’s config fragment into its host MCP settings, then call relay_status.' });
    } finally { store.close(); }
    return;
  }
  if (['agent-add', 'revoke', 'serve'].includes(command)) {
    requireThat(existsSync(join(state, 'relay.sqlite')), 'DATABASE_MISSING', 'Run init first with the same --state directory.');
    const store = new Store(join(state, 'relay.sqlite'));
    let serving = false;
    try {
      if (command === 'agent-add') {
        const identity = store.issueIdentity(need('project-id'), need('agent'), values.rotate ?? false);
        const path = identityPath(state, identity.projectId, identity.agentId);
        privateWrite(path, identity); print({ projectId: identity.projectId, agentId: identity.agentId, identityFile: path });
      } else if (command === 'revoke') print(store.revoke(need('project-id'), need('agent')));
      else {
        const http = await startHttp(store, values.port === undefined ? 7331 : Number(values.port));
        serving = true;
        process.stderr.write(`Project Relay listening at ${http.url}; MCP ${http.url}/mcp\n`);
        let stopping = false;
        const shutdown = async () => { if (stopping) return; stopping = true; await http.close(); store.close(); };
        process.once('SIGINT', () => { void shutdown(); });
        process.once('SIGTERM', () => { void shutdown(); });
      }
    } finally { if (!serving) store.close(); }
    return;
  }
  const path = resolve(need('identity'));
  const { store, identity } = openIdentity(path);
  let connected = false;
  try {
    if (command === 'config') print(clientConfig(path, identity.projectId, values.format ?? 'generic'));
    if (command === 'call') print(await dispatch(store, identity.token, need('tool'), JSON.parse(values.input ?? '{}')));
    if (command === 'watch') {
      let cursor = Number(values.after ?? 0);
      const abort = new AbortController();
      process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
      while (!abort.signal.aborted) {
        try {
          const result = await dispatch(store, identity.token, 'relay_events', { after: cursor, waitMs: 25_000 }, abort.signal);
          const data = result.data as { events: unknown[]; nextCursor: number };
          for (const event of data.events) process.stdout.write(JSON.stringify(event) + '\n');
          cursor = data.nextCursor;
        } catch (error) { if (!abort.signal.aborted) throw error; }
      }
    }
    if (command === 'mcp') {
      const abort = new AbortController();
      const server = serveStdio(() => createMcpServer(store, identity.token, abort.signal), {
        onerror: () => process.stderr.write('Project Relay MCP transport error.\n'),
      });
      let stopping = false;
      const shutdown = async () => { if (stopping) return; stopping = true; abort.abort(); await server.close(); store.close(); };
      connected = true;
      process.stdin.once('end', () => { void shutdown(); });
      process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
    }
  } finally { if (!connected) store.close(); }
}
main().catch(error => { process.stderr.write(JSON.stringify({ ok: false, error: errorBody(error) }) + '\n'); process.exitCode = 1; });
