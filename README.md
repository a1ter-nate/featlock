# FeatLock (`featlock` / `flk`)

**Lock your product features, linked tests, and deep invariants so AI agents never silently lose, break, or duplicate them.**

FeatLock is the third pillar alongside [RepoSpec](https://github.com/a1ter-nate/repospec) (architecture graph compiler) and [Veristack](https://github.com/a1ter-nate/veristack) (9-rung verification ladder). Built from day one on the **OpenCode v2 tight-core + dogfooded-plugin architecture**:

- **Canonical Git-tracked SQL (`features/registry.sql`) + SQLite (`.featlock/registry.sqlite`)** with engine-level `BEFORE DELETE` `RAISE(ABORT, ...)` triggers protecting active features, linked tests, and invariants.
- **Multi-source extraction & invariant discovery** via dogfooded first-party plugins:
  - `@featlock/plugin-ast-scanner` (`oxc-parser` AST extraction for exports, tests, preconditions, CLI contracts, SQL triggers)
  - `@featlock/plugin-repospec-bridge` (consumes `repospec.sqlite`, `repospec.json`, and `rules/*.sql` architectural invariants)
  - `@featlock/plugin-veristack-bridge` (consumes `.verification/control-plan.json`, `.verification/laws/*.laws.json`, and `.verification/rungs.json`)
  - `@featlock/plugin-invariant-passes` (structured 4-pass AI agent investigation packets: Inventory → Test Binding → Deep Invariant Mining → Regression Guard Audit)
- **Guarded anti-deletion enforcement (`@featlock/plugin-anti-deletion-guard`)** — non-removable `guarded: true` plugin blocking silent feature/invariant deletions, warning loudly on ADR-approved removals (`ALLOW_FEATURE_REMOVAL=1`), verifying linked tests exist and aren't skipped, and flagging unrecorded staged changes.
- **Agent harnesses & portable skill** (`@featlock/plugin-harnesses` + `skill/SKILL.md`) for Claude Code, Codex, Cursor, and GitHub Copilot.

## Quick Start

```bash
bun install
bun run check

# Extract features, tests, and invariants from any repo
bun src/cli.ts extract /path/to/repo --write
bun src/cli.ts check /path/to/repo

# Emit 4-pass AI agent invariant discovery packets
bun src/cli.ts agent-pass /path/to/repo --json

# Easy ON/OFF plugin proof
bun src/cli.ts --plugin ./examples/plugins/demo-toggle demo-ping
bun src/cli.ts --plugin ./examples/plugins/demo-toggle extract .
bun src/cli.ts extract .   # OFF: zero trace of demo-toggle
```
