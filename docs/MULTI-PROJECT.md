# Multiple projects, separate conversations

One Project Relay installation and one state directory can serve multiple repositories simultaneously. Each project has its own UUID and identities. Conversations, notes, tasks, event visibility, deduplication, acknowledgements, and file claims remain scoped to that project.

Two repositories may have the same folder name, agent names, note keys, task titles, or relative file paths. Their canonical root paths create distinct project groups. The relay does not connect projects based on names or Git remotes.

## Set up each repository

```sh
project-relay init --project /path/to/project-a
project-relay init --project /path/to/project-b
project-relay projects
```

Both commands use `~/.project-relay` unless you supply `--state DIR`. Repeat the same `--state` on later setup, administration, config, and HTTP server commands. Re-running `init` on a canonical root reuses its existing project and credentials.

`projects` prints a JSON object containing the state directory and each project's UUID, name, canonical root, creation time, and active identity count. This is a local administrative command, not an MCP tool exposed to other agents.

For each project, `init` creates identities for `claude-vscode`, `deepseek`, and `gemini-antigravity` by default. Reusing those names across projects is supported; each receives a different project-bound token. Use distinct IDs for concurrent agent sessions within one project.

## Separate editor conversations

Keep a separate agent conversation or session for each repository. Merge that project's generated identity fragment into its corresponding host settings, following the [integration guide](INTEGRATIONS.md). Each MCP server process authenticates to exactly one project, independently of its working directory.

At the start of work, ask the agent to call `relay_status` and verify the UUID and root against the repository it is editing. Project A's Claude communicates with project A's DeepSeek and Gemini. The same names in project B participate in a separate conversation.

### Hosts with global MCP settings

Select project UUIDs explicitly; do not select by display name:

```sh
project-relay config --agent gemini-antigravity \
  --projects PROJECT_A_UUID,PROJECT_B_UUID \
  --format antigravity
```

Use `--format claude`, `vscode`, or `generic` for another host and its corresponding `--agent` ID. Each selected project must already contain a valid identity for that agent. Unknown, mismatched, missing, duplicate, or revoked selections fail the command rather than producing a partial config. It never enrolls additional agents or includes unselected projects.

The output contains one server entry per selected project. Each key is `relay-` followed by that project's complete UUID without hyphens. Each entry references only that project's identity file; tokens are not embedded in host settings. There is no mutable active-project setting and no project override argument on tools.

Replace the host's previous **Project Relay entries** with the selected entries and preserve unrelated MCP servers. Configuration output does not edit existing host settings. Keep separate conversations and select the correct server in each conversation. A host given both projects' credentials can read both: the relay isolates API requests, not the host's own model context or OS filesystem access.

## One HTTP broker, separate credentials

```sh
project-relay serve
```

One loopback HTTP server serves all projects in its state directory. Each request's Bearer credential determines its project. Agent names, request bodies, and URLs cannot override that binding.

Create a separate adapter instance for each enrolled identity:

```python
from examples.harness_adapter import Relay

projects = {
    "project-a": Relay("/path/printed/by/project-a-init/deepseek.identity.json"),
    "project-b": Relay("/path/printed/by/project-b-init/deepseek.identity.json"),
}

project_a_inbox = projects["project-a"].call("relay_inbox", {})
project_b_inbox = projects["project-b"].call("relay_inbox", {})
```

Route each adapter's results to that project's own agent session. Store inbox acknowledgements and event cursors by `(projectId, agentId)`, not just agent name. Do not forward notes or messages between projects. A single cursor reused across project feeds can skip unread events because sequence numbers are database-wide.

## Worktrees and upgrades

Git worktrees for the same collaboration should reuse the original project's identities. A separately initialized root creates a separate conversation even if it has the same Git remote. Use a different state directory if you also want separate database files.

Existing v0.1.0 identity files and databases remain compatible; no data migration or reinitialization is required. Existing MCP entries named `project-relay-` plus a short UUID prefix still work. Newly generated v0.2.0 entries use the complete UUID to prevent collisions; remove an older entry for the same project when replacing it, so the host does not load duplicate connections. Check that the generated Node and CLI paths still exist after changing an installation location.

## Verified behavior

The automated suite runs six independent MCP processes across two projects at the same time, including separate messages, notes, task handoffs, acknowledgements, and identical file paths. It also checks the shared HTTP broker, three-project CLI enrollment, explicit config selection, cross-project resource rejection, and revocation without affecting an identically named agent in another project. These are real protocol processes with scripted clients, not live vendor model sessions.
