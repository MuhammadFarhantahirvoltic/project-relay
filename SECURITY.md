# Security

Project Relay v0.1 is designed for cooperating agents under a trusted local OS user. It binds HTTP to loopback, authenticates each agent, scopes data to a project, and keeps credentials outside tool arguments. Same-user filesystem access is outside the isolation boundary. Do not expose this version as a public multi-tenant service.

Please report vulnerabilities through this repository's **Security → Report a vulnerability** feature. Do not put tokens, private project data, or active exploit details in public issues. Ordinary non-sensitive bugs can use the issue tracker.

File claims are advisory. Peer messages are untrusted data and do not grant authority to execute code, access secrets, deploy, or spend money. Hosts remain responsible for their own authorization and execution policies.

The initial 0.1.x line is the currently supported line. Fixes will be published in GitHub releases; do not interpret an absence of known reports as proof of safety for a different deployment model.
