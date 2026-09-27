# Contributing to Project Relay

Useful contributions include adapters for specific coding harnesses, clear setup instructions, protocol bug reports, and tests for coordination failures.

1. Fork and clone the repository.
2. Install Node.js 22.13+ and Python 3.10+.
3. Run `npm ci`, `npm test`, and `npm run demo`.
4. Create a branch, keep the change focused, and open a pull request describing the behavior and verification.

Protocol changes should update `docs/PROTOCOL.md` and preserve existing clients when possible. Tools are defined in `src/tools.ts`; shared state lives in `src/store.ts`. Use the existing core and transport tests to exercise an invariant or a real failure case rather than duplicating implementation details.

Never commit identity files, `.relay/`, database sidecars, tokens, model API keys, private project content, or personal machine paths. Share a sanitized minimal reproduction. Bug reports should specify the OS, Node version, harness, transport, expected behavior, and observed behavior.

For a new harness adapter, document where the tool configuration goes, how incoming messages are checked, and what has been verified in a real host versus a scripted client. Do not imply that standard MCP automatically wakes an idle agent.

Be respectful and constructive. Harassment, spam, fake engagement, and attempts to bypass another project's security or approval requirements do not belong here.
