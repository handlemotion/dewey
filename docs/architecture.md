# Architecture

Dewey is a single desktop application with strict process and tool boundaries.
It is intentionally not a provider router, plugin marketplace, or distributed
agent platform.

## System

```text
Renderer
  ├─ React interface and audio devices
  ├─ ConversationRuntime
  └─ short-lived realtime credential
        │
        ▼
Sandboxed preload bridge
        │
        ▼
Main process
  ├─ AppController
  ├─ encrypted credentials
  ├─ SQLite state
  ├─ Exa and Firecrawl
  └─ Malcolm ToolLoopAgent
```

The renderer never receives long-lived provider keys or direct filesystem,
shell, or arbitrary IPC access. The main process validates every IPC payload
and owns all durable state and external actions.

## Dewey and Malcolm

Dewey is the realtime primary agent. It understands native audio, answers
ordinary questions, runs fast tools, explains delegation, and presents results.

Malcolm is a separate AI SDK `ToolLoopAgent` for work that benefits from an
isolated context: multi-source research, repository analysis, long synthesis,
and substantial planning. A task includes its objective, expected output,
selected recent conversation excerpts, and bounded user-approved memory.

Malcolm has explicit step, output, retry, and timeout limits. It can search and
read selected files, but it cannot send, publish, purchase, delete, write local
files, run host shell commands, or deploy. It returns consequential ideas as
proposals for Dewey to present.

## Tool policy

Tools have one of five risk levels:

| Risk | Behavior |
| --- | --- |
| `read` | Runs within an existing permission |
| `draft` | Produces content without crossing an external boundary |
| `write` | Requires exact, immediate approval |
| `financial` | Requires approval and a visible cost |
| `destructive` | Requires approval and an irreversibility warning |

Approvals bind the tool, canonical arguments, target, expected effect,
originating task, and expiry. Changing any argument invalidates approval.
Unavailable provider tools are omitted from model tool definitions.

## State

SQLite stores conversations, transcripts, citations, tool calls, tasks,
approvals, usage, settings, provider metadata, browser profiles, memory, and
audit events. Migrations are ordered and transactional. Interrupted work is
reconciled on startup; raw audio is never stored.

Provider credentials use Electron `safeStorage`. The credential file and
database are owner-only on POSIX systems. The database itself is not encrypted,
so the operating system account and full-disk encryption remain part of the
trust boundary.

## Source map

```text
src/main/       Electron main process, tools, agents, storage, and IPC
src/preload/    Narrow typed renderer bridge
src/renderer/   React interface and realtime runtime
src/shared/     Contracts, model configuration, and policy
tests/          High-value policy and persistence tests
```
