import { Database } from "bun:sqlite";
import type {
  DiscoveredFile,
  FenceRung,
  GuardViolation,
  RegistrySnapshot,
} from "@featlock/plugin";
import { findRepoSpecSqlite } from "./impact.ts";

const FENCE_RANK: Readonly<Record<FenceRung, number>> = {
  none: 0,
  runtime: 1,
  R3: 2,
  R2: 3,
  R1: 4,
  R0: 5,
};

export function fenceStrength(rung: FenceRung | undefined): number {
  return FENCE_RANK[rung ?? "runtime"];
}

export interface ScatteringReport {
  readonly dosByFeature: Readonly<Record<string, number>>;
  readonly dofByFile: Readonly<Record<string, number>>;
  readonly highScattering: readonly { readonly featureId: string; readonly files: number }[];
  readonly highTangling: readonly { readonly file: string; readonly features: readonly string[] }[];
}

export interface FeatureInteractionPair {
  readonly featureA: string;
  readonly featureB: string;
  readonly sharedVia: readonly string[];
  readonly sharedTests: readonly string[];
  readonly pairwiseGap: boolean;
}

export interface FeatureFlagFinding {
  readonly flag: string;
  readonly file: string;
  readonly line: number;
  readonly status: "linked" | "unlinked" | "constant";
}

export function computeScatteringAndTangling(registry: RegistrySnapshot): ScatteringReport {
  if (!registry) throw new Error("RegistrySnapshot is required.");
  const filesByFeature = new Map<string, Set<string>>();
  const featuresByFile = new Map<string, Set<string>>();

  for (const inv of registry.invariants) {
    if (inv.status !== "active" || !inv.file) continue;
    const fSet = filesByFeature.get(inv.featureId) ?? new Set<string>();
    fSet.add(inv.file);
    filesByFeature.set(inv.featureId, fSet);

    const fileSet = featuresByFile.get(inv.file) ?? new Set<string>();
    fileSet.add(inv.featureId);
    featuresByFile.set(inv.file, fileSet);
  }

  const dosByFeature: Record<string, number> = {};
  const highScattering: Array<{ readonly featureId: string; readonly files: number }> = [];
  for (const [fid, set] of [...filesByFeature.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    dosByFeature[fid] = set.size;
    if (set.size >= 8) highScattering.push({ featureId: fid, files: set.size });
  }

  const dofByFile: Record<string, number> = {};
  const highTangling: Array<{ readonly file: string; readonly features: readonly string[] }> = [];
  for (const [file, set] of [...featuresByFile.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    dofByFile[file] = set.size;
    if (set.size >= 3) highTangling.push({ file, features: [...set].toSorted() });
  }
  return { dosByFeature, dofByFile, highScattering, highTangling };
}

function collectRepoSpecSharedResources(
  repoRoot: string,
  fileToFeatures: Map<string, Set<string>>,
  sharedByPair: Map<string, Set<string>>,
): void {
  const dbPath = findRepoSpecSqlite(repoRoot);
  if (!dbPath) return;
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!tables.has("entity_access")) return;
    const rows = db.query("SELECT file, entity FROM entity_access LIMIT 2000").all() as Array<{ file: string; entity: string }>;
    const byEntity = new Map<string, Set<string>>();
    for (const r of rows) {
      const feats = fileToFeatures.get(r.file);
      if (!feats) continue;
      const set = byEntity.get(r.entity) ?? new Set<string>();
      for (const f of feats) set.add(f);
      byEntity.set(r.entity, set);
    }
    for (const [entity, feats] of byEntity.entries()) {
      const sorted = [...feats].toSorted();
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const key = `${sorted[i]}|${sorted[j]}`;
          const via = sharedByPair.get(key) ?? new Set<string>();
          via.add(`entity:${entity}`);
          sharedByPair.set(key, via);
        }
      }
    }
  } catch {
    return;
  } finally {
    db.close();
  }
}

export function computeFeatureInteractions(
  registry: RegistrySnapshot,
  repoRoot: string,
): FeatureInteractionPair[] {
  if (!registry) throw new Error("RegistrySnapshot is required.");
  const fileToFeatures = new Map<string, Set<string>>();
  for (const inv of registry.invariants) {
    if (inv.status !== "active" || !inv.file) continue;
    const set = fileToFeatures.get(inv.file) ?? new Set<string>();
    set.add(inv.featureId);
    fileToFeatures.set(inv.file, set);
  }

  const sharedByPair = new Map<string, Set<string>>();
  for (const [file, feats] of fileToFeatures.entries()) {
    if (feats.size < 2) continue;
    const sorted = [...feats].toSorted();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}|${sorted[j]}`;
        const via = sharedByPair.get(key) ?? new Set<string>();
        via.add(`file:${file}`);
        sharedByPair.set(key, via);
      }
    }
  }

  collectRepoSpecSharedResources(repoRoot, fileToFeatures, sharedByPair);

  const testsByFeature = new Map<string, Set<string>>();
  for (const t of registry.tests) {
    const set = testsByFeature.get(t.featureId) ?? new Set<string>();
    set.add(t.testPath);
    testsByFeature.set(t.featureId, set);
  }

  const pairs: FeatureInteractionPair[] = [];
  for (const [key, via] of [...sharedByPair.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const [featureA = "", featureB = ""] = key.split("|");
    const testsA = testsByFeature.get(featureA) ?? new Set<string>();
    const testsB = testsByFeature.get(featureB) ?? new Set<string>();
    const sharedTests = [...testsA].filter((p) => testsB.has(p)).toSorted();
    pairs.push({
      featureA,
      featureB,
      sharedVia: [...via].toSorted(),
      sharedTests,
      pairwiseGap: testsA.size > 0 && testsB.size > 0 && sharedTests.length === 0,
    });
  }
  return pairs;
}

export function detectFeatureFlags(
  files: readonly DiscoveredFile[],
  registry: RegistrySnapshot,
): FeatureFlagFinding[] {
  if (!registry) throw new Error("RegistrySnapshot is required.");
  const registeredText = registry.features
    .map((f) => `${f.id} ${f.area} ${f.name} ${f.summary}`)
    .join(" ")
    .toLowerCase();
  const findings: FeatureFlagFinding[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    if (f.isTest) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const constMatch = /\bconst\s+(FEATURE_[A-Z0-9_]+)\s*=\s*(true|false)\b/.exec(line);
      if (constMatch?.[1]) {
        const key = `${constMatch[1]}|${f.rel}|${i + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ flag: constMatch[1], file: f.rel, line: i + 1, status: "constant" });
        }
      }
      const callMatch = /\b(?:isEnabled|flags\.get|featureFlags\.get)\s*\(\s*["']([A-Za-z0-9_.:-]+)["']\s*\)/.exec(line);
      if (callMatch?.[1]) {
        const flag = callMatch[1];
        const key = `${flag}|${f.rel}|${i + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          const linked = registeredText.includes(flag.toLowerCase());
          findings.push({ flag, file: f.rel, line: i + 1, status: linked ? "linked" : "unlinked" });
        }
      }
    }
  }
  return findings;
}

export function checkFeatureRelations(registry: RegistrySnapshot): GuardViolation[] {
  const relations = registry.relations ?? [];
  if (relations.length === 0) return [];
  const violations: GuardViolation[] = [];
  const byId = new Map(registry.features.map((f) => [f.id, f]));

  for (const rel of relations) {
    const from = byId.get(rel.fromFeatureId);
    const to = byId.get(rel.toFeatureId);
    if (rel.relation === "requires" && from?.status === "active" && (!to || to.status === "removed")) {
      violations.push({
        id: `FLK:rel-requires:${rel.fromFeatureId}:${rel.toFeatureId}`,
        rule: "relation-requires-broken",
        severity: "error",
        featureId: rel.fromFeatureId,
        file: "features/registry.sql",
        message: `BLOCKED: Active feature '${rel.fromFeatureId}' requires '${rel.toFeatureId}', which is missing or removed.`,
        fix: `Keep '${rel.toFeatureId}' active or retire/update '${rel.fromFeatureId}' first.`,
      });
    }
    if (rel.relation === "excludes" && from?.status === "active" && to?.status === "active") {
      violations.push({
        id: `FLK:rel-excludes:${rel.fromFeatureId}:${rel.toFeatureId}`,
        rule: "relation-excludes-conflict",
        severity: "error",
        featureId: rel.fromFeatureId,
        file: "features/registry.sql",
        message: `BLOCKED: Active features '${rel.fromFeatureId}' and '${rel.toFeatureId}' declare a mutual 'excludes' constraint.`,
        fix: "Deactivate or deprecate one of the mutually exclusive features.",
      });
    }
  }

  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const rel of relations) {
    if (rel.relation !== "parent_of") continue;
    const list = adj.get(rel.fromFeatureId) ?? [];
    list.push(rel.toFeatureId);
    adj.set(rel.fromFeatureId, list);
    if (!inDegree.has(rel.fromFeatureId)) inDegree.set(rel.fromFeatureId, 0);
    inDegree.set(rel.toFeatureId, (inDegree.get(rel.toFeatureId) ?? 0) + 1);
  }
  const ready: string[] = [];
  for (const [node, deg] of inDegree.entries()) {
    if (deg === 0) ready.push(node);
  }
  let visitedCount = 0;
  for (let head = 0; head < ready.length; head += 1) {
    const node = ready[head] ?? "";
    visitedCount += 1;
    for (const next of adj.get(node) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) ready.push(next);
    }
  }
  if (visitedCount < inDegree.size) {
    const cyclic = [...inDegree.entries()].find(([, deg]) => deg > 0)?.[0] ?? "unknown";
    violations.push({
      id: `FLK:rel-parent-cycle:${cyclic}`,
      rule: "relation-parent-cycle",
      severity: "error",
      featureId: cyclic,
      file: "features/registry.sql",
      message: `BLOCKED: Cycle detected in 'parent_of' feature hierarchy involving '${cyclic}'.`,
      fix: "Break the cycle in feature_relations so the feature hierarchy remains a DAG.",
    });
  }
  return violations;
}
