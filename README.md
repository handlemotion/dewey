<div align="center">
  <h1>Dewey</h1>
  <p>A local-first desktop AI assistant built for natural conversation and deliberate action.</p>

  [![CI](https://github.com/handlemotion/dewey/actions/workflows/ci.yml/badge.svg)](https://github.com/handlemotion/dewey/actions/workflows/ci.yml)
  [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
</div>

Dewey is an open-source Electron application with native realtime voice, local
persistence, explicit approval for consequential actions, and a separate
deep-work agent named Malcolm.

> [!NOTE]
> Dewey is under active development. Build it from source; signed public
> releases are not available yet.

## Features

- Native speech-to-speech conversation with interruption and selectable audio devices.
- Malcolm, an isolated AI SDK agent for substantial research and analysis.
- Exa search and managed Firecrawl browser workflows.
- Exact, expiring approvals for writes, purchases, and destructive actions.
- Local SQLite history, tasks, usage, settings, and user-controlled memory.
- OS-encrypted provider credentials and a sandboxed Electron renderer.

## Quick start

You need Node.js 24+, pnpm 10+, and an OpenAI API key.

```bash
corepack enable
pnpm install
pnpm dev
```

Open **Settings** in Dewey and add your OpenAI key. Exa and Firecrawl are
optional and their tools remain unavailable until configured.

Provider API usage is billed by each provider. Dewey displays estimates, but
provider dashboards remain the billing source of truth.

### Environment bootstrap

Settings is the preferred way to configure credentials. For development only,
you may copy `.env.example` to `.env.local`. Dewey imports those values into
encrypted OS storage on first launch; delete the plaintext file afterward.
Packaged builds do not read `.env.local` from their launch directory.

## How it works

```text
React renderer
  └─ ConversationRuntime ── OpenAI Realtime
       └─ typed preload bridge
            └─ AppController
                 ├─ SQLite
                 ├─ Exa and Firecrawl
                 └─ Malcolm (AI SDK ToolLoopAgent)
```

Dewey owns the live conversation and normal tools. Malcolm receives a bounded,
fresh context only when deeper work is useful. Read-only tools can run inside
their configured permissions; external writes require an exact approval.

See [Architecture](docs/architecture.md) for the technical boundaries.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm package` creates an unpacked build for the current platform.
`pnpm dist` creates native installers. CI verifies and
packages macOS, Windows, and Linux independently.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please
report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## License

Apache-2.0 © HandleMotion. See [LICENSE](LICENSE).
