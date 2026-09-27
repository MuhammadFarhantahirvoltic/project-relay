# Verification record

Verified locally on 2026-09-27 using Node.js 22.22.3, Python 3.14.7, and the official MCP SDK packages at 2.1.0.

`npm test` runs TypeScript compilation, core coordination checks, and real transport integration checks. The suite currently contains 20 tests covering:

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

`npm run demo` runs a separate, scripted three-peer collaboration scenario over real MCP subprocesses. It demonstrates shared context, ownership, a rejected file conflict, handoff, acknowledgement, and a result broadcast. It uses no provider API or live model sessions.

The production dependency audit (`npm audit --omit=dev`) reported zero known vulnerabilities after removing the unnecessary HTTP-framework adapter dependency. The HTTP bridge uses the official SDK's web-standard handler and Node's built-in HTTP server.

Remaining checks: live sessions inside Claude Code, Antigravity, and individual DeepSeek harnesses; host-specific wakeup integration; Windows support; and load testing at production scale. File claims are advisory, and the broker is designed for one machine. The public website is a scripted protocol replay, not a hosted coordination broker.
