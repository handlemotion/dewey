# Contributing

Thanks for helping improve Dewey.

## Setup

You need Node.js 24+ and pnpm 10+.

```bash
git clone https://github.com/handlemotion/dewey.git
cd dewey
corepack enable
pnpm install
pnpm dev
```

Provider-backed tests or manual smokes require your own credentials. Store them
through Dewey Settings; never commit credentials or test with someone else's
account.

## Before a pull request

Keep changes focused and preserve the product boundaries described in
[Architecture](docs/architecture.md).

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Add tests for security boundaries, migrations, approval behavior, or failure
recovery. Avoid tests that only mirror implementation details.

Update documentation only when public behavior or a durable architectural
decision changes. Prefer improving an existing page over adding another one.

## Pull requests

Explain the problem, the chosen solution, and how you verified it. Do not
include generated installers, provider credentials, raw audio, or local
databases.

By contributing, you agree that your contribution is licensed under
[MIT](LICENSE).
