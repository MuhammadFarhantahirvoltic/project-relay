# Project Relay privacy policy

Effective September 29, 2026. This policy covers the open-source Project Relay reference server and its Claude Code plugin, maintained by Muhammad Farhan Tahir. It describes the released local software; it does not cover a separate service someone may build or host from the source.

## Data the software handles

Project Relay reads and stores the coordination data that you and your enrolled agents explicitly provide: messages, shared notes, task descriptions and results, file-claim paths, project roots and names, agent identifiers and presence metadata, timestamps, acknowledgements, and event records. This content can contain personal information, such as names or email addresses, if you or an agent includes it. Relay does not automatically read repository file contents, browser history, contacts, or other applications' credentials.

Setup generates a separate local credential for each project and agent. The server reads the selected Project Relay identity file to authenticate that agent. These are Relay credentials, not credentials copied from another service. The database stores credential hashes; private identity files hold the usable local tokens.

## Where data is stored and who receives it

By default, the SQLite database and identity files are stored under `~/.project-relay` on the machine where Relay runs. The standalone CLI can use an explicitly selected state directory. These files are not encrypted by Relay; access depends on your OS account, filesystem permissions, and disk security.

Enrolled agents in the same project can receive shared messages, notes, tasks, and claims. Direct messages and their events are filtered to the participating identities. Projects have separate credentials and conversations. Processes with access to the local database or identity files are inside the trusted local boundary; Relay is not a security sandbox between untrusted users.

Tool results are returned to the connected host, such as Claude Code. That host may send them to its model provider according to your host configuration and the provider's policies. Other enrolled agents can do the same. Share only information that you are authorized to make available to those agents and providers.

The Project Relay plugin itself makes no outbound network requests and starts no public listener. The optional standalone HTTP server listens on loopback and exchanges data with authenticated local clients. The maintainer operates no hosted Relay service, receives no Relay coordination data automatically, and receives no built-in telemetry or analytics from the server or plugin.

Installation and updates download public plugin code from GitHub and locked dependencies from the npm registry. Those services and the client performing the downloads may process ordinary request information under their own policies. Visiting the GitHub repository or GitHub Pages website is also subject to GitHub's policies. Relay's website adds no analytics script.

Relevant third-party notices are the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement), [npm privacy notice](https://docs.npmjs.com/policies/privacy/), and [Anthropic privacy policy](https://www.anthropic.com/legal/privacy). If you connect another host or model provider, review that provider's privacy policy and data controls before sharing content through it.

## Retention, access, and deletion

Local coordination records have no automatic retention deadline and can remain longer than 30 days. Expiring task or file leases do not erase historical messages or events. Uninstalling the Claude plugin does not delete the shared `~/.project-relay` state directory.

You control your local files. You can read project records through the Relay tools or inspect a local database backup. To remove local Relay data, stop the connected agents and server, then delete the intended state database and its associated files and identities. Deleting a shared state directory removes all projects stored in it, so preserve any projects you need first. This does not remove copies already sent to other agents, model providers, exports, or backups; manage those copies with their respective owners and services. The maintainer cannot remotely access or delete your local state.

## Support and changes

Project Relay is a general developer tool and is not directed specifically at children. For privacy questions, use the [project's support discussions](https://github.com/MuhammadFarhantahirvoltic/project-relay/discussions). Do not post personal data, credentials, private project content, or private logs in public issues or discussions. Information you voluntarily post there is handled by GitHub and is visible according to the post's access settings.

Policy changes will be published in this repository with an updated effective date. Review the policy and release notes when updating the software.
