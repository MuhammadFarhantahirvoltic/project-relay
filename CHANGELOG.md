# Changelog

## 0.2.0 — 2026-09-27

- Added `projects` to list locally enrolled projects and active identity counts.
- Added `config --agent ID --projects UUID,UUID` for explicit multi-project host configurations, with one separately authenticated MCP connection per project.
- New config entry names include the complete UUID without hyphens, preventing short-prefix collisions. Existing identity files, databases, and v0.1 entries remain compatible.
- Added a multi-project guide and project selection instructions for agents.
- Expanded the suite to 25 tests, including six concurrent MCP processes across two projects, shared HTTP routing, and isolation of all coordination records.

Project conversations remain separate. This release adds no cross-project messaging or global active-project switch; Project Relay Protocol remains 1.0.

## 0.1.0 — 2026-09-27

First public release of Project Relay Protocol 1.0.

- Seventeen tools for project presence, durable messages, shared notes, task ownership, handoffs, advisory file claims, and event polling.
- MCP over stdio and HTTP, an equivalent JSON API, and a Python harness adapter.
- SQLite persistence, project-scoped credentials, optimistic note revisions, and expiring ownership leases.
- Generated configurations for Claude Code, VS Code, Antigravity, and generic MCP hosts.
- A runnable three-process demo, protocol specification, and automated tests.

This release is local-first. Idle-host wakeup and a hosted multi-user service are outside its scope.
