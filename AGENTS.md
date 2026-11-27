# FeatLock Agent Guidelines

- Keep `packages/core` tight and language-agnostic; ship capabilities as dogfooded plugins under `packages/plugins/*` importing only `@featlock/plugin`.
- Before adding a capability, run `bun src/cli.ts query <topic>` and `bun src/cli.ts check-dup "<description>"`.
- On any feature addition or improvement, update `features/registry.sql` via `record-new` or `record-improvement`.
- Never silently delete active features, linked tests, or invariants.
- Run `bun run check` (`typecheck`, `bun test`, `oxlint`, `vstack`, `featlock check .`) before every commit.
