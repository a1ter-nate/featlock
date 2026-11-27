---
name: featlock
description: Guard product features, linked tests, and deep invariants with SQLite traceability, AST + RepoSpec + Veristack scanners, and multi-pass AI agent discovery.
---

# FeatLock Agent Workflow

Use FeatLock before adding, modifying, or removing any product capability so features and invariants are never silently lost, broken, or duplicated.

## 4-Pass Invariant & Feature Protocol

1. **Orient before coding**
   - Run `featlock query <topic>` and `featlock check-dup "<proposed feature>"`.
   - If a matching feature exists, improve it instead of recreating it.
2. **Extract & mine invariants (deterministic + agent passes)**
   - Run `featlock extract . --json` (combines AST, RepoSpec, and Veristack bridges).
   - Run `featlock agent-pass . --json` and execute Passes 1–4 (Inventory → Test Binding → Deep Invariant Mining → Guard Audit).
3. **Record automatically**
   - New capability: `featlock record-new --id feat.<area>.<slug> --area <area> --name "<Name>" --summary "<Summary>" --test <path/to/test.ts>`
   - Improvement to existing capability: `featlock record-improvement --id <featureId> --summary "<What improved>" --test <path/to/test.ts>`
4. **Never silently delete features or invariants**
   - `features/registry.sql` enforces SQLite `BEFORE DELETE` `RAISE(ABORT, ...)` triggers and git-diff anti-deletion guards.
   - If asked to remove an active feature or invariant, STOP, confirm with the user, record an ADR reference + `removal_reason`, and run `ALLOW_FEATURE_REMOVAL=1 featlock check .`.
