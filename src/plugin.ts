import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { identityPath, openIdentity } from './setup.js';
import { requireThat } from './errors.js';

/** An exact project root is selected by the host, never by an MCP tool call. */
export function projectConnection(projectRoot: string, stateDirectory: string, agentId: string) {
  requireThat(!projectRoot.includes('${'), 'INVALID_PROJECT', 'The host did not resolve CLAUDE_PROJECT_DIR. Update Claude Code or pass an absolute project path.');
  const root = realpathSync(resolve(projectRoot));
  requireThat(statSync(root).isDirectory(), 'INVALID_PROJECT', 'Project path must be a directory.');
  requireThat(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentId), 'INVALID_AGENT', 'Provide a valid agent ID.');
  const state = resolve(stateDirectory);
  const database = join(state, 'relay.sqlite');
  let bound: ReturnType<typeof openIdentity> | undefined;
  let closed = false;
  return {
    get() {
      requireThat(!closed, 'CONNECTION_CLOSED', 'The project connection is closed.');
      if (!bound) {
        const setupMessage = 'Run /project-relay:setup in this project before using the relay. No project has been selected automatically.';
        requireThat(existsSync(database), 'PROJECT_NOT_ENROLLED', setupMessage);
        const lookup = new Store(database);
        let project;
        try { project = lookup.listProjects().find(item => item.root === root); }
        finally { lookup.close(); }
        requireThat(project, 'PROJECT_NOT_ENROLLED', setupMessage);
        const path = identityPath(state, project.id, agentId);
        requireThat(existsSync(path), 'IDENTITY_MISSING', 'Run /project-relay:setup to enroll the Claude Code identity for this project.');
        const opened = openIdentity(path);
        try {
          requireThat(opened.identity.projectId === project.id && opened.identity.agentId === agentId && opened.identity.database === database,
            'IDENTITY_MISMATCH', 'The identity does not match this project, agent, and state directory.');
          bound = opened;
        } catch (error) { opened.store.close(); throw error; }
      }
      return { store: bound.store, token: bound.identity.token };
    },
    close() { if (!closed) { closed = true; bound?.store.close(); } },
  };
}
