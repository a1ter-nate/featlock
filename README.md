# FeatLock (`featlock` / `flk`)

**Lock your product features, linked tests, and deep invariants so AI agents never silently drop, weaken, or duplicate them.**

FeatLock is the third pillar alongside [RepoSpec](https://github.com/a1ter-nate/repospec) (architecture graph compiler) and [Veristack](https://github.com/a1ter-nate/veristack) (9-rung verification ladder). Built on a tight-core + dogfooded-plugin architecture:

- **Canonical Git-tracked SQL (`features/registry.sql`) + SQLite (`.featlock/registry.sqlite`)** with engine-level `BEFORE DELETE` `RAISE(ABORT, ...)` triggers protecting active features, linked tests, and invariants.
- **Live code-anchored invariant protection:** Every extracted guard stores a line-number-independent `guard_anchor` and exact `root_test_path`. Deleting or weakening a guard in source code—or deleting a feature module without an ADR—blocks immediately (`invariant-guard-dropped-in-code` / `feature-removed-from-code`), while benign line shifts produce zero false positives.
- **Polyglot extraction & bridge plugins** across TypeScript, Rust, Python, Go, C#, and SQL:
  - `@featlock/plugin-ast-scanner` (`oxc-parser` + polyglot guard/symbol/root-test extractor)
  - `@featlock/plugin-repospec-bridge` (consumes `repospec.sqlite`, `repospec.json`, and `rules/*.sql`)
  - `@featlock/plugin-veristack-bridge` (consumes `.verification/control-plan.json`, `.verification/laws/*.laws.json`, and `.verification/rungs.json`)
  - `@featlock/plugin-invariant-passes` (4-pass AI agent discovery packets: Inventory → Test Binding → Deep Invariant Mining → Regression Guard Audit)
- **Non-removable anti-deletion guard (`@featlock/plugin-anti-deletion-guard`, `guarded: true`)** enforcing ADR-gated removals (`ALLOW_FEATURE_REMOVAL=1`), root-test liveness, and `--strict-drift` checks for unrecorded new features, invariants, and capability tests.
- **Agent harnesses & portable skill** (`@featlock/plugin-harnesses` + `skill/SKILL.md`) for Claude Code, Codex, Cursor, and GitHub Copilot.

## Install & Quick Start

Requires [Bun](https://bun.sh) `>= 1.2.0`.

```bash
bun add -d featlock

# 1. Extract features, exact root tests, and code-anchored invariants into features/registry.sql
bunx featlock extract . --write

# 2. Guard against silent feature/invariant regressions (and flag unrecorded additions)
bunx featlock check .
bunx featlock check . --strict-drift

# 3. Query existing features or check for overlap before building something new
bunx featlock query "auth"
bunx featlock check-dup "jwt bearer validation"

# 4. Record intentional new features or improvements
bunx featlock record-new --id feat.billing.retry --area billing --name "Retry Queue" --summary "Retries transient gateway failures" --test tests/billing.test.ts
bunx featlock record-improvement --id feat.billing.retry --summary "Added exponential backoff cap"

# 5. Emit 4-pass AI agent invariant discovery packets & wire coding-agent hooks
bunx featlock agent-pass . --json
bunx featlock hooks on
```

## License

[MIT](./LICENSE)
