import fs from "node:fs";
import path from "node:path";
import { Plugin, type CheckContext, type GuardViolation } from "@featlock/plugin";

const SKIPPED_TEST_RE = /\b(?:test|it|describe)\.(?:skip|todo)\s*\(/;

function checkActiveFeatureCoverage(ctx: CheckContext): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const activeFeatures = ctx.registry.features.filter((f) => f.status === "active");
  for (const feat of activeFeatures) {
    const linked = ctx.registry.tests.filter((t) => t.featureId === feat.id);
    if (linked.length === 0) {
      violations.push({
        id: `FLK:no-test:${feat.id}`,
        rule: "active-feature-requires-test",
        severity: "error",
        featureId: feat.id,
        file: "features/registry.sql",
        message: `Active feature '${feat.id}' (${feat.name}) has zero linked tests in feature_tests.`,
        fix: `Link at least one real test file to '${feat.id}' via 'featlock record-improvement'.`,
      });
      continue;
    }
    for (const link of linked) {
      const abs = path.join(ctx.repoRoot, link.testPath);
      if (!fs.existsSync(abs)) {
        violations.push({
          id: `FLK:missing-test:${feat.id}:${link.testPath}`,
          rule: "linked-test-must-exist",
          severity: "error",
          featureId: feat.id,
          file: link.testPath,
          message: `Feature '${feat.id}' references missing test file '${link.testPath}'.`,
          fix: `Restore '${link.testPath}' or update feature_tests with a live replacement test.`,
        });
        continue;
      }
      const content = fs.readFileSync(abs, "utf8");
      if (SKIPPED_TEST_RE.test(content)) {
        violations.push({
          id: `FLK:skipped-test:${feat.id}:${link.testPath}`,
          rule: "linked-test-not-skipped",
          severity: "warn",
          featureId: feat.id,
          file: link.testPath,
          message: `Linked test file '${link.testPath}' for feature '${feat.id}' contains skipped/todo tests.`,
          fix: "Remove .skip / .todo so feature coverage executes on every run.",
        });
      }
    }
  }
  return violations;
}

function checkInvariantLiveness(ctx: CheckContext): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const inv of ctx.registry.invariants) {
    if (inv.status !== "active") continue;
    const abs = path.join(ctx.repoRoot, inv.file);
    if (!fs.existsSync(abs)) {
      violations.push({
        id: `FLK:orphan-invariant:${inv.id}`,
        rule: "invariant-target-must-exist",
        severity: "error",
        featureId: inv.featureId,
        file: inv.file,
        message: `Active invariant '${inv.id}' points to missing file '${inv.file}'.`,
        fix: "Restore the guarded file or migrate the invariant to its new home with an audit entry.",
      });
    }
  }
  return violations;
}

function checkGitAntiDeletion(ctx: CheckContext): GuardViolation[] {
  if (!ctx.previousRegistry) return [];
  const violations: GuardViolation[] = [];
  const currentById = new Map(ctx.registry.features.map((f) => [f.id, f]));
  const currentInvById = new Map(ctx.registry.invariants.map((i) => [i.id, i]));

  for (const prev of ctx.previousRegistry.features) {
    if (prev.status !== "active") continue;
    const cur = currentById.get(prev.id);
    if (!cur) {
      violations.push({
        id: `FLK:feature-deleted:${prev.id}`,
        rule: "no-silent-feature-deletion",
        severity: "error",
        featureId: prev.id,
        file: "features/registry.sql",
        message: `BLOCKED: Active feature '${prev.id}' (${prev.name}) was deleted from features/registry.sql.`,
        fix: "Keep the feature active, or mark status='removed' with an explicit adr_ref + removal_reason AND ALLOW_FEATURE_REMOVAL=1.",
      });
    } else if (cur.status === "removed") {
      const hasAdr = Boolean(cur.adrRef && cur.adrRef.trim().length > 0 && cur.removalReason && cur.removalReason.trim().length > 0);
      if (!ctx.allowRemoval || !hasAdr) {
        violations.push({
          id: `FLK:unapproved-removal:${prev.id}`,
          rule: "feature-removal-requires-adr",
          severity: "error",
          featureId: prev.id,
          file: "features/registry.sql",
          message: `BLOCKED: Feature '${prev.id}' transitioned to 'removed' without adr_ref, removal_reason, and ALLOW_FEATURE_REMOVAL=1.`,
          fix: "Confirm intentional feature removal with the user, document adr_ref + removal_reason, and rerun with ALLOW_FEATURE_REMOVAL=1.",
        });
      } else {
        violations.push({
          id: `FLK:loud-removal-warning:${prev.id}`,
          rule: "loud-feature-removal-warning",
          severity: "warn",
          featureId: prev.id,
          file: "features/registry.sql",
          message: `LOUD WARNING: Feature '${prev.id}' (${prev.name}) is being REMOVED under ADR '${cur.adrRef}' (${cur.removalReason}).`,
          fix: "Double-check with the human owner before merging intentional feature removal.",
        });
      }
    }
  }

  for (const prevInv of ctx.previousRegistry.invariants) {
    if (prevInv.status !== "active") continue;
    const curInv = currentInvById.get(prevInv.id);
    if (!curInv || (curInv.status === "removed" && !ctx.allowRemoval)) {
      violations.push({
        id: `FLK:invariant-deleted:${prevInv.id}`,
        rule: "no-silent-invariant-deletion",
        severity: "error",
        featureId: prevInv.featureId,
        file: "features/registry.sql",
        message: `BLOCKED: Active invariant '${prevInv.id}' (${prevInv.statement}) was deleted or disabled without ALLOW_FEATURE_REMOVAL=1.`,
        fix: "Restore the invariant or explicitly approve its deprecation with an ADR.",
      });
    }
  }
  return violations;
}

function checkStagedDiffRecorded(ctx: CheckContext): GuardViolation[] {
  if (ctx.stagedFiles.length === 0) return [];
  const touchesCodeOrTests = ctx.stagedFiles.some((f) => /\.(?:ts|tsx|js|mjs|py|rs|cs|go)$/.test(f));
  const touchesRegistry = ctx.stagedFiles.includes("features/registry.sql");
  if (!touchesCodeOrTests || touchesRegistry) return [];
  return [
    {
      id: "FLK:staged-unrecorded",
      rule: "staged-changes-record-feature",
      severity: "warn",
      file: "features/registry.sql",
      message: "Staged code/test changes have no matching new feature or 'improved' audit entry in features/registry.sql.",
      fix: "Run 'featlock record-new' or 'featlock record-improvement' before committing.",
    },
  ];
}

export default Plugin.define({
  id: "featlock.guard.anti-deletion",
  guarded: true,
  async setup(ctx) {
    await ctx.guard.transform((ed) => {
      ed.add({
        id: "featlock.guard.anti-deletion.core",
        guarded: true,
        evaluate: (checkCtx) => [
          ...checkActiveFeatureCoverage(checkCtx),
          ...checkInvariantLiveness(checkCtx),
          ...checkGitAntiDeletion(checkCtx),
          ...checkStagedDiffRecorded(checkCtx),
        ],
      });
    });
  },
});
