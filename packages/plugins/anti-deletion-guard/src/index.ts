import fs from "node:fs";
import path from "node:path";
import { Plugin, type CheckContext, type GuardViolation } from "@featlock/plugin";

const SKIPPED_TEST_RE = /^\s*(?:test|it|describe)\.(?:skip|todo)\s*\(/m;

function normalizeWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function checkActiveFeatureCoverage(ctx: CheckContext): GuardViolation[] {
  if (!ctx.repoRoot) throw new Error("CheckContext.repoRoot is required.");
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
  if (!ctx.repoRoot) throw new Error("CheckContext.repoRoot is required.");
  const violations: GuardViolation[] = [];
  const fileNormCache = new Map<string, string>();
  const readNormalized = (rel: string): string | null => {
    const cached: string | undefined = fileNormCache.get(rel);
    if (cached !== undefined) return cached;
    const abs = path.join(ctx.repoRoot, rel);
    if (!fs.existsSync(abs)) return null;
    const norm = normalizeWhitespace(fs.readFileSync(abs, "utf8"));
    fileNormCache.set(rel, norm);
    return norm;
  };

  for (const inv of ctx.registry.invariants) {
    if (inv.status !== "active") continue;
    const normContent = readNormalized(inv.file);
    if (normContent === null) {
      violations.push({
        id: `FLK:orphan-invariant:${inv.id}`,
        rule: "invariant-target-must-exist",
        severity: "error",
        featureId: inv.featureId,
        file: inv.file,
        message: `Active invariant '${inv.id}' points to missing file '${inv.file}'.`,
        fix: "Restore the guarded file or migrate the invariant to its new home with an audit entry.",
      });
      continue;
    }
    if (inv.guardAnchor && !ctx.allowRemoval) {
      const normAnchor = normalizeWhitespace(inv.guardAnchor);
      if (normAnchor.length > 0 && !normContent.includes(normAnchor)) {
        const rootHint = inv.rootTestPath ? ` (root test: ${inv.rootTestPath})` : "";
        violations.push({
          id: `FLK:dropped-guard:${inv.id}`,
          rule: "invariant-guard-dropped-in-code",
          severity: "error",
          featureId: inv.featureId,
          file: inv.file,
          message: `BLOCKED: Active invariant '${inv.id}' guard disappeared from '${inv.file}'${rootHint}: expected '${normAnchor}'.`,
          fix: `Restore the guard in '${inv.file}'${inv.rootTestPath ? ` and verify '${inv.rootTestPath}'` : ""}, or formally retire the invariant with an ADR + ALLOW_FEATURE_REMOVAL=1.`,
        });
      }
    }
    if (inv.rootTestPath && !fs.existsSync(path.join(ctx.repoRoot, inv.rootTestPath))) {
      violations.push({
        id: `FLK:missing-root-test:${inv.id}`,
        rule: "invariant-root-test-missing",
        severity: "error",
        featureId: inv.featureId,
        file: inv.rootTestPath,
        message: `Active invariant '${inv.id}' root test '${inv.rootTestPath}' is missing.`,
        fix: `Restore '${inv.rootTestPath}' or re-bind the invariant to a live root test.`,
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

function checkLiveExtractionDrift(ctx: CheckContext): GuardViolation[] {
  if (ctx.registry.features.length === 0) return [];
  const violations: GuardViolation[] = [];
  const severity = ctx.strictDrift ? "error" : "warn";
  const regFeatureIds = new Set(ctx.registry.features.map((f) => f.id));
  const regInvIds = new Set(ctx.registry.invariants.map((i) => i.id));
  const regAnchors = new Set(
    ctx.registry.invariants
      .filter((i) => i.guardAnchor)
      .map((i) => `${i.file}|${normalizeWhitespace(i.guardAnchor ?? "")}`),
  );

  for (const liveFeat of ctx.liveExtraction.features) {
    if (regFeatureIds.has(liveFeat.id)) continue;
    violations.push({
      id: `FLK:new-feature:${liveFeat.id}`,
      rule: "unrecorded-new-feature",
      severity,
      featureId: liveFeat.id,
      file: "features/registry.sql",
      message: `Unrecorded new feature '${liveFeat.id}' (${liveFeat.name}) detected in codebase.`,
      fix: `Run 'featlock extract --write' or 'featlock record-new --id ${liveFeat.id}' to lock this feature into features/registry.sql.`,
    });
  }

  const regTestKeys = new Set(ctx.registry.tests.map((t) => `${t.featureId}|${t.testPath}`));
  for (const liveTest of ctx.liveExtraction.tests) {
    if (!regFeatureIds.has(liveTest.featureId)) continue;
    if (regTestKeys.has(`${liveTest.featureId}|${liveTest.testPath}`)) continue;
    violations.push({
      id: `FLK:new-test:${liveTest.featureId}:${liveTest.testPath}`,
      rule: "unrecorded-new-feature-test",
      severity,
      featureId: liveTest.featureId,
      file: liveTest.testPath,
      message: `Unrecorded new capability test '${liveTest.testPath}' linked to '${liveTest.featureId}'.`,
      fix: `Run 'featlock extract --write' or 'featlock record-improvement --id ${liveTest.featureId} --test ${liveTest.testPath}' to save it.`,
    });
  }

  for (const liveInv of ctx.liveExtraction.invariants) {
    if (liveInv.source !== "ast" || !liveInv.guardAnchor) continue;
    const anchorKey = `${liveInv.file}|${normalizeWhitespace(liveInv.guardAnchor)}`;
    if (regInvIds.has(liveInv.id) || regAnchors.has(anchorKey)) continue;
    const rootHint = liveInv.rootTestPath ? ` (root test: ${liveInv.rootTestPath})` : "";
    violations.push({
      id: `FLK:new-invariant:${liveInv.id}`,
      rule: "unrecorded-new-invariant",
      severity,
      featureId: liveInv.featureId,
      file: liveInv.file,
      message: `Unrecorded new invariant '${liveInv.id}' in '${liveInv.file}:${liveInv.line}'${rootHint}: ${liveInv.statement}`,
      fix: "Run 'featlock extract --write' or 'featlock record-improvement' to save this invariant in features/registry.sql.",
    });
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
          ...checkLiveExtractionDrift(checkCtx),
          ...checkStagedDiffRecorded(checkCtx),
        ],
      });
    });
  },
});
