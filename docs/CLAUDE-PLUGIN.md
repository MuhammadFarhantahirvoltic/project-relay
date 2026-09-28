# Project Relay for Claude Code

Install the plugin once, then enroll each repository separately. Claude gets the same 17 MCP coordination tools as other hosts, plus `/project-relay:setup`, `/project-relay:inbox`, and `/project-relay:coordinate`. Messages and project state stay on your machine.

## Install from the community marketplace

Requires **Node.js 22.13+**, npm, and a current Claude Code version. Run these inside Claude Code:

```text
/plugin marketplace add MuhammadFarhantahirvoltic/project-relay
/plugin install project-relay@project-relay-marketplace
```

Start Claude Code at the root of your repository and run:

```text
/project-relay:setup
/project-relay:inbox
```

The marketplace is maintained by Project Relay. Availability here does not mean Anthropic has reviewed or listed the plugin in its official directory. This release is prepared for directory submission; official directory publication is a separate review step.

Claude Code installs the dependencies pinned in `package-lock.json` with lifecycle scripts disabled. Readable JavaScript is included in `plugin/runtime/`, so no build or compiler is needed at installation. If an older client does not install dependencies or substitute `CLAUDE_PROJECT_DIR`, update Claude Code. For a local source checkout, run `npm ci` before `claude --plugin-dir /absolute/path/to/project-relay`.

## Connect the other agents

Setup creates `claude-code`, `deepseek`, and `gemini-antigravity` identities in `~/.project-relay`. It prints private identity file locations and config fragments; the fragments contain file paths, not tokens. Merge the appropriate fragment into each host's MCP configuration and verify `relay_status`. The model name does not determine compatibility: its host must support MCP, or use the [HTTP adapter](INTEGRATIONS.md).

Generated peer configs point to the plugin's installed version. Claude may clean up old plugin versions after updates. Regenerate peer configs after an update, or install the standalone release in a stable location and use its CLI to generate those configs. Never copy identity files into Git or paste their tokens into a conversation.

## Multiple projects and existing setups

Open a separate Claude Code session at each repository root and run setup there. The host supplies `CLAUDE_PROJECT_DIR`; the MCP connection binds to **exactly that enrolled canonical directory**, not a parent directory, a project name, or a global last-used project. An uninitialized plugin can list its tools, but calls return a setup instruction and create no state. After setup, the same connection works without restarting. Once connected, it cannot switch projects.

Existing default-state projects are reused. Setup adds the `claude-code` identity without rotating or revoking other identities. A revoked or mismatched identity fails closed and needs explicit administrator repair.

For a custom state directory, several simultaneous Claude windows in one project, or Git worktrees that share one logical project, use the standalone `config --identity FILE` integration with a distinct identity for each agent/window. Disable this plugin's MCP connection in those sessions to avoid duplicate identities. Do not initialize each worktree as a separate project if its agents should share the same conversation. See [multiple projects](MULTI-PROJECT.md).

## What runs and where data goes

- Claude Code starts Node with the bundled CLI as a local stdio MCP server. No shell command, automatic setup hook, model API call, or public listener starts on install.
- The host downloads the plugin from GitHub and its locked Node dependencies from the npm registry during installation. Relay itself makes no outbound network requests in plugin mode.
- Explicit setup creates the SQLite database, project-scoped credentials, and connection fragments under `~/.project-relay`. Runtime reads those identities and stores only coordination data submitted through its tools. It does not scan your source files.
- Enrolled peers in the same project can read shared messages, notes, tasks, and claims; direct messages are restricted to their participating identities. Tool responses are given to Claude Code and are subject to that host's normal model/data settings.
- This is for trusted processes under the same OS user. It is not a sandbox between mutually untrusted users. Claims are advisory and messages do not wake idle editors.

The release targets **Claude Code**. Local stdio and shared host paths are not available in Claude web chat. Cowork's execution environment has not been verified against another host's local SQLite database, so cross-editor coordination in Cowork is not claimed.

## Maintainers: validate and submit

```sh
npm ci
npm test
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
git diff --exit-code -- plugin/runtime
```

The runtime is generated deterministically by `npm run build` from `src/`. Commit runtime changes with their source. Never commit dependencies, SQLite files, identities, `.relay`, or `artifacts`.

Submit the public GitHub repository, plugin path `/` (the repository root), through [Claude's developer portal](https://claude.ai/directory/manage/new). Use **Plugin bundle**, validate the repository, address findings, then submit for review. The npm lockfile can trigger manual dependency review under the [directory checklist](https://claude.com/docs/plugins/pre-submission-checklist). Local CLI validation is not directory approval.
