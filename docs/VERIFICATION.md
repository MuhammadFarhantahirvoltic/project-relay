# Verification record

Verified locally on 2026-09-29 using a fresh locked dependency installation, Node.js 22.22.3, Python 3.14.7, and the official MCP SDK packages at 2.1.0.

`npm test` runs TypeScript compilation, core coordination checks, and real transport integration checks. The suite currently contains 28 tests covering:

- Project-bound credentials, sender impersonation rejection, and cross-project isolation.
- Direct and broadcast delivery, acknowledgement recovery, atomic receipt batches, pagination, and idempotent sends.
- Private event visibility, shared-note revisions, and persistent state across database connections.
- Exclusive task claims, ownership fencing, expiry, handoff, terminal states, and credential revocation.
- Atomic file claim batches, parent/child overlaps, case aliases, traversal rejection, renewal, and stale-lease rejection.
- Heartbeat expiry, malformed input, long-poll delivery, cancellation, and revocation during polling.
- Three separately spawned MCP server processes communicating over actual stdio pipes.
- Simultaneous task/file claims from separate processes, with exactly one winner.
- Older initialize-based and 2026-07-28 MCP connections over stdio and HTTP.
- HTTP authentication, Host/Origin protection, request limits, validation, and JSON API/MCP interoperability.
- A separate Python process using the supplied HTTP harness adapter.
- Repeatable CLI setup, identity-file permissions, working config fragments, and unknown-option rejection.
- Six simultaneous MCP processes across two projects with identical agent names and file paths.
- Cross-project message, receipt, reply, task, handoff, note, file lease, presence, event, and revocation isolation.
- Multiple projects sharing one HTTP endpoint and three-project CLI enrollment with explicit config selection.
- Missing/revoked/mismatched identities, duplicate or invalid project selections, and colliding short UUID prefixes.
- The plugin's actual MCP command, first-time enrollment without a restart, and no state creation before explicit setup.
- Simultaneous plugin sessions in separate projects, rejected project overrides, exact-root binding, and revoked/mismatched identity rejection.

`npm run demo` runs a separate, scripted three-peer collaboration scenario over real MCP subprocesses. It demonstrates shared context, ownership, a rejected file conflict, handoff, acknowledgement, and a result broadcast. It uses no provider API or live model sessions.

Claude Code 2.1.284 passed strict plugin and marketplace validation. In an isolated temporary Claude profile, marketplace installation succeeded, `plugin details` discovered all three skills and one MCP server, and `mcp list` reported the plugin server connected with the host's project directory substituted. The 28-test suite also exercises the manifest's actual command over real stdio. This verifies installation, discovery, and transport connectivity; it is not a live-model skill evaluation or official directory review.

The production dependency audit (`npm audit --omit=dev`) reported zero known vulnerabilities after removing the unnecessary HTTP-framework adapter dependency. The HTTP bridge uses the official SDK's web-standard handler and Node's built-in HTTP server.

Remaining checks: live sessions inside Claude Code, Antigravity, and individual DeepSeek harnesses; host-specific wakeup integration; Windows support; and load testing at production scale. File claims are advisory, and the broker is designed for one machine. The public website is a scripted protocol replay, not a hosted coordination broker.
