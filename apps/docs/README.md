# Fluxgram Docs

Fumadocs/Next app for the Fluxgram documentation.

## Development

From the repository root:

```sh
bun run docs:dev
```

Open http://localhost:3000.

## Checks

```sh
bun run docs:typecheck
bun run docs:build
```

The docs content lives in `apps/docs/content/docs`. Fumadocs generated files are written to `apps/docs/.source` and ignored by git.
