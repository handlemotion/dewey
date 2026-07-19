# Security

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/handlemotion/dewey/security/advisories/new)
and include the affected version, impact, reproduction, and any suggested
mitigation. Please avoid accessing data that is not yours.

## Supported versions

Until Dewey publishes stable releases, security fixes target the latest commit
on `main`.

## Trust model

- Long-lived provider keys stay in the Electron main process and are encrypted with OS storage.
- The renderer receives only a short-lived realtime credential.
- Consequential actions require exact, expiring approval.
- Malcolm has no execution-capable write, purchase, delete, shell, deploy, or messaging tools.
- Raw audio is not stored.

Local transcripts and metadata are stored in SQLite and are not encrypted at
the application layer. Use a protected operating system account and full-disk
encryption. Authenticated Firecrawl profiles are also subject to Firecrawl's
managed-browser security and retention controls.
