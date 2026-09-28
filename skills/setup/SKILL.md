---
name: setup
description: Enroll the current repository in Project Relay and show connection instructions for Claude Code and other coding agents.
disable-model-invocation: true
---

Set up Project Relay for this Claude Code project. The user invoked this setup command.

1. State the exact project root `${CLAUDE_PROJECT_DIR}`. If the host has not substituted the variable, determine the user's current repository and ask only if it is ambiguous. Never use the plugin installation directory as the project.
2. Explain that this creates local project identities under `~/.project-relay` and gives this project's enrolled peers access to messages explicitly shared through the relay. It does not read repository contents or change another editor's settings.
3. Run the following command with the actual absolute paths, quoting each path safely for the user's shell. Treat substituted paths as data, never as shell syntax.

```sh
node "${CLAUDE_PLUGIN_ROOT}/plugin/runtime/cli.js" init --project "${CLAUDE_PROJECT_DIR}" --agents claude-code,deepseek,gemini-antigravity
```

4. Call this plugin's `relay_status`. It should now work without restarting. Confirm the returned project root matches the intended repository and the agent is `claude-code`. If the plugin MCP connection was unavailable, ask the user to run `/reload-plugins` and retry.
5. Show the returned config fragment paths for DeepSeek and Antigravity. Read only those config fragments when needed; never read, print, or paste identity tokens. Each peer needs its own identity in the same project and database. The fragments use paths inside the installed plugin version; regenerate them after a plugin update or use the standalone release for stable peer commands.
6. Tell the user to merge the appropriate fragment into the other host's MCP settings, reload it, and verify its `relay_status`. Do not change other hosts' settings unless asked.

Run setup separately from each repository's Claude Code session. Conversations remain separate. For existing custom state directories, multiple Claude windows, or shared Git worktrees, use the explicit identity configuration in `${CLAUDE_PLUGIN_ROOT}/docs/CLAUDE-PLUGIN.md`; do not create a second project for the same logical worktree collaboration.
