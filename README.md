# Fluxgram Repository

Fluxgram is a TypeScript workspace for building durable, resumable Telegram bot flows on top of grammY.

The npm package lives in `packages/fluxgram`. This root README is for people working in the repository: where the code lives, how to run checks, and how the demo/docs apps fit together.

## Workspaces

| Path                | Package         | Purpose                                                                                                     |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/fluxgram` | `fluxgram`      | The library package published to npm. Its README is the public package documentation.                       |
| `apps/kitchen-demo` | `kitchen-demo`  | A real Telegram bot used to manually exercise flows, prompts, timers, messaging, events, and observability. |
| `apps/docs`         | `fluxgram-docs` | Fumadocs/Next documentation site.                                                                           |

## Requirements

- Bun
- Node.js for Node smoke tests and npm packaging checks
- Docker when running Redis/Postgres-backed adapter checks
- A Telegram bot token only when running `apps/kitchen-demo`

Install dependencies from the repository root:

```sh
bun install
```

## Common Commands

```sh
bun test              # fluxgram package tests
bun run typecheck     # package, demo app, and docs typechecks
bun run lint          # package, demo app, and docs lint
bun run format:check  # formatting check across packages and apps
bun run docs:dev      # start the docs app
bun run docs:build    # build the docs app
```

Package-specific commands can be run from `packages/fluxgram`:

```sh
bun test
bun run typecheck
bun run build
bun run smoke:node
```

## Library Package

The published library source is in `packages/fluxgram/src`. Public docs for package consumers are in `packages/fluxgram/README.md`.

Important areas:

- `src/steps`: step factories such as `send`, `prompt`, `sleep`, branches, continuations, and subflows.
- `src/engine`: flow registry, execution, per-chat queueing, persistence, timers, and recovery.
- `src/storage`: memory, SQLite, Redis, Postgres, and Mongo storage adapters.
- `src/events`: in-process, Redis, and Mongo event buses.
- `src/observability`: structured flow events and sinks.
- `testing`: test harness and conformance helpers for library consumers and adapter work.

## Demo Bot

The kitchen demo is the fastest way to manually exercise the library in Telegram.

```sh
cp apps/kitchen-demo/.env.example apps/kitchen-demo/.env
# Fill BOT_TOKEN in apps/kitchen-demo/.env
bun --filter kitchen-demo dev
```

See `apps/kitchen-demo/README.md` for the menu coverage and group-chat test notes.

## Docs Site

Run the documentation site from the repository root:

```sh
bun run docs:dev
```

Docs content lives in `apps/docs/content/docs`.

## Adapter Verification

Most tests do not need external services. Redis and Postgres conformance can be run against local Docker containers when changing durable adapters:

```sh
docker run -d --rm --name fluxgram-test-redis -p 6379:6379 redis:7-alpine
docker run -d --rm --name fluxgram-test-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine

cd packages/fluxgram
REDIS_URL=redis://localhost:6379 \
POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres \
bun test tests/storage-conformance.test.ts

REDIS_URL=redis://localhost:6379 \
POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres \
bun run smoke:node
```

The Redis conformance path exercises Bun Redis and the Node `redis` package. The Postgres path exercises Bun SQL and the Node `pg` package.

## Publishing Package Changes

`packages/fluxgram` is the publishable package. Before publishing, build from that package directory:

```sh
cd packages/fluxgram
bun run build
npm pack --dry-run
```

The package README and MIT license live beside `packages/fluxgram/package.json` so npm displays the consumer-facing documentation.
