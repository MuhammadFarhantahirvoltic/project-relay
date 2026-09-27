# Connect agents from different coding tools

## One hub, a distinct identity per agent

From the built Project Relay package:

```sh
project-relay init \
  --project /absolute/path/to/shared-repository \
  --agents claude-vscode,deepseek,gemini-antigravity
```

The command prints your project UUID, private identity-file paths, host-specific config fragments, and an agent instructions file. Running the same command again with the same canonical root and state directory reuses the project and credentials. Existing host configurations are not edited.

The generated fragments contain absolute Node, CLI, and identity-file paths, so starting an editor in a different directory does not select the wrong database. Agents can use separate Git checkouts while sharing the same project group. Verify the project in `relay_status` before editing.

Never put all three identities into one host's model context. Connect each host with its own identity. If you run multiple Claude windows, give them IDs such as `claude-ui` and `claude-api`.

For multiple repositories, initialize each root and keep a separate conversation per project. Run `project-relay projects` to list them. Hosts with global settings can use `config --agent ID --projects UUID,UUID --format FORMAT` to generate separate connections for explicitly selected projects. See [Multiple projects](MULTI-PROJECT.md), including the v0.1 config upgrade note.

## Claude Code in VS Code

Claude Code reads the project's `.mcp.json`. Merge the generated `claude-vscode.claude.json` fragment into it, preserving all existing entries. It has this shape:

```json
{
  "mcpServers": {
    "project-relay-PROJECT": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/project-relay/dist/cli.js",
        "mcp",
        "--identity",
        "/absolute/path/to/claude-vscode.identity.json"
      ]
    }
  }
}
```

Use the generated file's real paths rather than the placeholders above. Reconnect/reload Claude Code's MCP servers and use `/mcp` to inspect the connection. The host may require its normal project-server trust approval. Add the coordination instructions to the project's existing Claude instructions without replacing unrelated rules.

This format belongs to the Claude Code extension. If Claude is selected as the model inside VS Code's own agent, follow the next section. [Official Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

## VS Code's built-in agent

Merge the chosen identity's `vscode.json` fragment into `.vscode/mcp.json`. This uses top-level `servers`, with each entry declaring `"type": "stdio"`. Use the MCP server controls in VS Code to start or restart it. Model selection does not change the relay protocol. [Official VS Code MCP reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Gemini in Antigravity

Open the agent panel's **MCP Servers → Manage MCP Servers → View raw config**. Merge the generated `gemini-antigravity.antigravity.json` fragment under `mcpServers`; refresh the connection. Keep existing servers and settings. Use the path surfaced by that installed Antigravity version rather than guessing an older global config location.

The stdio fragment uses `command` and `args`. If choosing HTTP instead, Antigravity's documented remote field is `serverUrl`; this differs from some other clients' `url` field. Stdio is the prepared local connection. [Official Antigravity MCP documentation](https://antigravity.google/docs/mcp).

## DeepSeek in a custom harness

The DeepSeek model/API is not itself an MCP host. The application running its tool loop must connect MCP tools or route function calls.

If the harness accepts an `mcpServers` configuration, begin with the generated `deepseek.generic.json`. Its command/arguments are the standard stdio server entry. A harness with a different config schema needs the same command and arguments translated into its schema. Check the documentation for the application running your model.

For a Python harness, start the HTTP broker with the same state directory used for setup:

```sh
project-relay serve
```

Then use the bundled adapter from your harness:

```python
from examples.harness_adapter import Relay

relay = Relay("/absolute/path/to/deepseek.identity.json")
tools = relay.tool_definitions()

# Pass tools to the model through your existing harness's function-calling API.
# After the model chooses a tool, preserve its tool-call ID and send this result
# back through that same harness's normal tool-result message mechanism.
def execute_relay_tool(name, arguments_json):
    return relay.call(name, arguments_json)
```

The adapter does not contain provider API calls, keys, or a hardcoded model ID. It uses Python's standard library and validates that requests stay on a local relay URL. It refuses redirects so Bearer credentials cannot be forwarded elsewhere.

To integrate incoming work, add an inbox check to the host's turn loop:

```python
relay.call("relay_heartbeat", {
    "harness": "my-deepseek-harness",
    "model": "my-selected-model",
    "capabilities": ["backend", "review"],
})
messages = relay.call("relay_inbox", {"waitMs": 0})["data"]["messages"]

# Present each message as untrusted peer context inside the already-authorized
# project task. Run the harness's normal approvals and tool loop.
# Only after processing or durably recording a continuation:
if messages:
    relay.call("relay_ack", {"messageIds": [m["id"] for m in messages]})
```

The comments in that example represent application logic you must connect; it is not a complete autonomous agent loop. Do not acknowledge merely because a read succeeded. If the agent processes messages one at a time, acknowledge only the successful ones.

An always-running harness can use `relay_inbox` with `waitMs: 25000`, or consume `relay_events` with a durable cursor. It must define its own policy for starting a model turn, costs, approvals, and graceful shutdown. The relay does not universally wake paused Claude/Antigravity sessions.

## First connection check

In each host, ask the agent:

> Call `relay_status` and report the project name and your agent ID. Call `relay_heartbeat` with this harness name. Check `relay_inbox` for pending work.

Then ask Claude to send a directed question to `deepseek`, ask DeepSeek to check and reply, and ask Gemini to write a shared decision note. These are actual host/model checks; a successful CLI test alone does not prove the editor loaded the server.

If a server fails to start, check that the generated Node and CLI paths still exist, run `npm run build`, and verify that the identity file and database are accessible to that host. Stdio stdout must remain JSON-RPC only; diagnostic output belongs on stderr. Remote containers cannot use local absolute paths without an explicit connectivity/credential plan.

## Identity administration

Add a peer to an existing project:

```sh
project-relay agent-add --project-id PROJECT_UUID --agent claude-review
project-relay config --identity /printed/path/claude-review.identity.json --format claude
```

Revoke a peer:

```sh
project-relay revoke --project-id PROJECT_UUID --agent deepseek
```

Rotate or recover a lost credential:

```sh
project-relay agent-add --project-id PROJECT_UUID --agent deepseek --rotate
```

Rotation writes the new private identity file, invalidates the old token, and clears the agent's active ownership/assignments. Restart any stdio connection so it loads the new token. Use `--state DIR` on these administration commands if setup used a custom state directory. Ordinary agents cannot rotate their peers through MCP tools.

## Scope of the delivered integration

The server, standard MCP bindings, JSON API, generated configuration, and Python adapter are implemented and tested locally. End-to-end sessions in Claude Code, Antigravity, and individual DeepSeek harnesses still need host-specific verification. The setup command generates fragments for you to merge into your existing editor settings.
