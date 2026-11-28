---
name: featlock
description: Guard product features, linked tests, and deep invariants with SQLite traceability, AST + RepoSpec + Veristack scanners, Reiss multi-signal anchoring, DoS/DoF & pairwise interaction analysis, and multi-pass AI agent discovery.
---

# FeatLock Agent Workflow

Use FeatLock before adding, simplifying, modifying, or removing any product capability so features and invariants are never silently lost, weakened, or duplicated.

## 4-Pass Invariant & Feature Protocol

1. **Orient before coding (BM25 + Concern Graph)**
   - Run `featlock query <topic>` (returns matching features, DoS, `feature_relations`, and RepoSpec concern subgraph when `repospec.sqlite` is present) and `featlock check-dup "<proposed feature>"`.
   - If a matching feature exists, improve it instead of recreating it.
2. **Extract & mine invariants (deterministic + agent passes)**
   - Run `featlock extract . --json` (AST + RepoSpec + Veristack + Reiss multi-signal fingerprints + Canfora-Cerulo bugfix-origin tagging).
   - Run `featlock agent-pass . --json` and execute Passes 1–4 (Inventory → Test Binding → Deep Invariant Mining & Fence Rungs → Regression/DoS/Interaction Audit).
   - Report unguarded invariants honestly as `No fence yet` (`fence_rung = 'none'`) and never downgrade an existing `fence_rung`.
3. **Record with Pre-RS provenance & relations**
   - New capability: `featlock record-new --id feat.<area>.<slug> --area <area> --name "<Name>" --summary "<Summary>" --test <path/to/test.ts> [--origin-ref <uri>] [--rationale "<why>"] [--requires <featId>] [--excludes <featId>] [--parent <featId>]`
   - Improvement: `featlock record-improvement --id <featureId> --summary "<What improved>" [--test <path/to/test.ts>] [--origin-ref <uri>] [--rationale "<why>"] [--requires <featId>]`
4. **Behavior-preserving `uncomplect` rewrites (`supersede`)**
   - When simplifying a runtime guard into a stronger static fence (e.g., `R1` type boundary or `R0` lint — *"Parse, Don't Validate"*), keep the black-box `root_test_path` green and run:
     `featlock supersede --id <invId> --by type-boundary --rung R1 --rationale "<why>"`
   - No `ALLOW_FEATURE_REMOVAL=1` is needed when the fence rung stays equal or gets stronger and `root_test_path` stays live.
5. **Fast targeted verification & structural health**
   - Run `featlock affected-tests [base..head]` to select and prioritize regression tests (bugfix-origin & high-invariant features first, with STARTS transitive closure when `repospec.sqlite` is present).
   - Run `featlock matrix` to inspect Degree of Scattering (`DoS`), Degree of Tangling (`DoF`), pairwise (`t=2`) feature interaction test gaps, and stale/unlinked feature flags.
6. **Never silently delete features or invariants**
   - `features/registry.sql` enforces SQLite `BEFORE DELETE` `RAISE(ABORT, ...)` triggers, `feature_relations` consistency (`requires`/`excludes`/`parent_of` DAG), fence monotonicity, and git-diff anti-deletion guards.
   - If asked to remove an active feature or invariant, STOP, confirm with the user, record `adr_ref` + `removal_reason`, ensure no active feature `requires` it, and run `ALLOW_FEATURE_REMOVAL=1 featlock check .`.

## Reporting False Positives or Tool Bugs Upstream

If FeatLock reports a false positive, misses a real regression, or crashes:
1. **Never leak proprietary client code, internal paths, or secrets.**
2. Run `featlock report --rule <id> --file <path:line> --anonymize --reason "<why>"` (or craft a generic minimal repro). Default mode is a safe dry-run that scrubs paths and credentials.
3. For NDA/offline or multi-repo sweeps, append locally with `--local` (queues scrubbed JSONL in `.verification/tool-feedback.jsonl` with zero network calls), then review a deduplicated roll-up with `featlock report --flush`.
4. Inspect the scrubbed preview, then file via `--submit` (when `gh` is available and approved — `--flush --submit` clears the queue only on success) or `--url` (or `--flush --clear` to clear manually).
