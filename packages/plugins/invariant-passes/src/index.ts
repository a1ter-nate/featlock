import { Plugin, type AgentPassPacket, type RegistrySnapshot, type ScanContext } from "@featlock/plugin";

function buildPass1Inventory(ctx: ScanContext, registry: RegistrySnapshot): AgentPassPacket {
  const registeredAreas = new Set(registry.features.map((f) => f.area));
  const prodFiles = ctx.files.filter((f) => !f.isTest).map((f) => f.rel);
  return {
    passId: "pass-1-feature-inventory",
    title: "Pass 1: Product Feature Surface Discovery",
    objective: "Identify every user-facing and system-level product capability from routes, CLI commands, exported APIs, jobs, and docs without duplicating existing features.",
    instructions: [
      `Already registered areas (${registeredAreas.size}): ${[...registeredAreas].toSorted().join(", ") || "none"}.`,
      "Run 'featlock check-dup <description>' (BM25 + identifier-split) before proposing any new feature.",
      "Capture Pre-RS provenance (--origin-ref, --rationale) and cross-feature relations (--requires, --excludes, --parent).",
      "Ignore internal scaffolding; focus on observable behaviors users or downstream callers depend on.",
    ],
    targets: prodFiles.slice(0, 60),
    outputSchema: {
      features: [{ id: "feat.<area>.<slug>", area: "string", name: "string", summary: "string", acceptanceCriteria: "string", originRef: "optional-uri", rationale: "optional-why" }],
    },
  };
}

function buildPass2TestBinding(ctx: ScanContext, registry: RegistrySnapshot): AgentPassPacket {
  const linkedPaths = new Set(registry.tests.map((t) => t.testPath));
  const unlinkedTests = ctx.files.filter((f) => f.isTest && !linkedPaths.has(f.rel)).map((f) => f.rel);
  const untestedFeatures = registry.features
    .filter((f) => f.status === "active" && !registry.tests.some((t) => t.featureId === f.id))
    .map((f) => f.id);
  return {
    passId: "pass-2-test-binding",
    title: "Pass 2: Feature-to-Test Traceability & Pairwise Interaction Binding",
    objective: "Bind every active feature to real, non-skipped tests (R0-R8) and close pairwise (t=2) feature-interaction test gaps.",
    instructions: [
      `Active features lacking linked tests (${untestedFeatures.length}): ${untestedFeatures.join(", ") || "none"}.`,
      `Unlinked test files (${unlinkedTests.length}): inspect and bind to matching features.`,
      "Run 'featlock matrix --json' to locate interacting feature pairs that lack a shared pairwise integration test.",
    ],
    targets: unlinkedTests.slice(0, 60),
    outputSchema: {
      links: [{ featureId: "string", testPath: "string", testPattern: "string", rung: "R0|R1|R2|R3|R4|R5|R6|R7|R8" }],
    },
  };
}

function buildPass3InvariantMining(ctx: ScanContext, registry: RegistrySnapshot): AgentPassPacket {
  const activeInvs = registry.invariants.filter((i) => i.status === "active");
  const unguarded = activeInvs.filter((i) => i.fenceRung === "none").map((i) => i.id);
  const bugfixCount = activeInvs.filter((i) => i.originKind === "bugfix").length;
  const criticalFiles = ctx.files
    .filter((f) => !f.isTest && /(?:guard|policy|state|machine|schema|auth|billing|payment|registry|pipeline|router|contract)/i.test(f.rel))
    .map((f) => f.rel);
  return {
    passId: "pass-3-invariant-mining",
    title: "Pass 3: Deep Invariant Mining, Fence Rungs & Type Promotion",
    objective: "Discover hidden behavioral, state-machine, ordering, permission, and persistence invariants, tag each fence_rung honestly, and promote weak guards toward R0/R1.",
    instructions: [
      `Currently locked active invariants: ${activeInvs.length} (bugfix-origin: ${bugfixCount}, No fence yet: ${unguarded.length}).`,
      unguarded.length > 0 ? `Invariants with 'No fence yet' (fence_rung=none): ${unguarded.slice(0, 10).join(", ")}.` : "Zero active invariants are left prose-only ('No fence yet').",
      "Tag every invariant with fence_rung (R0|R1|R2|R3|runtime|none); never pretend prose is a fence — report 'No fence yet' honestly.",
      "When simplifying code via uncomplect / 'Parse, Don't Validate', promote runtime guards to R1 types or R0 lints using 'featlock supersede --id <inv> --by type-boundary --rung R1'.",
    ],
    targets: (criticalFiles.length > 0 ? criticalFiles : ctx.files.filter((f) => !f.isTest).map((f) => f.rel)).slice(0, 60),
    outputSchema: {
      invariants: [{ id: "inv:agent:<slug>", featureId: "string", kind: "string", statement: "string", file: "string", line: 1, fenceRung: "R0|R1|R2|R3|runtime|none", confidence: 0.9 }],
    },
  };
}

function buildPass4RegressionAudit(ctx: ScanContext, registry: RegistrySnapshot): AgentPassPacket {
  const relCount = (registry.relations ?? []).length;
  return {
    passId: "pass-4-regression-guard-audit",
    title: "Pass 4: Regression, Scattering/Tangling & Anti-Deletion Audit",
    objective: "Audit registered features, relations, fence monotonicity, DoS/DoF scattering, and pairwise interaction gaps before shipping.",
    instructions: [
      `Audit ${registry.features.length} features, ${registry.tests.length} test links, ${registry.invariants.length} invariants, and ${relCount} feature relations.`,
      "Run 'featlock check .' and confirm 0 error violations (including zero fence downgrades or broken requires/excludes relations).",
      "Run 'featlock affected-tests' to run prioritized regression tests for touched files, and 'featlock matrix' to review DoS/DoF and feature flags.",
      "Confirm agent hooks ('featlock hooks status') and CI gates are wired so future agents cannot silently drop features.",
    ],
    targets: ["features/registry.sql", ...ctx.allRelPaths.filter((p) => /(?:AGENTS\.md|copilot-instructions\.md|rungs\.json)/i.test(p))],
    outputSchema: {
      status: "pass|fail",
      gaps: [{ featureId: "string", gap: "string", recommendedAction: "string" }],
    },
  };
}

export default Plugin.define({
  id: "featlock.invariant-passes",
  async setup(ctx) {
    await ctx.agentPass.transform((ed) => {
      ed.add({ id: "pass-1-inventory", order: 1, title: "Feature Surface Inventory", buildPacket: buildPass1Inventory });
      ed.add({ id: "pass-2-tests", order: 2, title: "Feature-to-Test Binding", buildPacket: buildPass2TestBinding });
      ed.add({ id: "pass-3-invariants", order: 3, title: "Deep Invariant Mining", buildPacket: buildPass3InvariantMining });
      ed.add({ id: "pass-4-audit", order: 4, title: "Regression & Guard Audit", buildPacket: buildPass4RegressionAudit });
    });
  },
});
