import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FeatureRecord, RegistrySnapshot } from "@featlock/plugin";

export interface ConcernSubgraph {
  readonly nodes: readonly string[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
  readonly crossBoundaryLeaks: readonly string[];
}

export interface AffectedTestResult {
  readonly changedFiles: readonly string[];
  readonly affectedFeatures: readonly string[];
  readonly transitiveFiles: readonly string[];
  readonly prioritizedTests: readonly {
    readonly testPath: string;
    readonly featureIds: readonly string[];
    readonly score: number;
    readonly reason: string;
  }[];
}

export function findRepoSpecSqlite(repoRoot: string): string | null {
  if (!repoRoot) return null;
  const candidates = [
    path.join(repoRoot, "repospec.sqlite"),
    path.join(repoRoot, ".repospec", "repospec.sqlite"),
    path.join(repoRoot, "out", path.basename(repoRoot), "repospec.sqlite"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function projectConcernSubgraph(
  repoRoot: string,
  feature: FeatureRecord,
  registry: RegistrySnapshot,
): ConcernSubgraph | null {
  const dbPath = findRepoSpecSqlite(repoRoot);
  if (!dbPath) return null;
  const ownFiles = new Set(
    registry.invariants.filter((i) => i.featureId === feature.id).map((i) => i.file),
  );
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!tables.has("edges")) return null;
    const rows = db.query("SELECT source, target, kind FROM edges LIMIT 3000").all() as Array<{
      source: string;
      target: string;
      kind: string;
    }>;
    const nodes = new Set<string>();
    const edges: Array<{ readonly from: string; readonly to: string; readonly kind: string }> = [];
    const leaks = new Set<string>();
    for (const r of rows) {
      const fromMatch = [...ownFiles].some((f) => r.source.includes(f)) || r.source.includes(feature.area);
      const toMatch = [...ownFiles].some((f) => r.target.includes(f)) || r.target.includes(feature.area);
      if (!fromMatch && !toMatch) continue;
      nodes.add(r.source);
      nodes.add(r.target);
      edges.push({ from: r.source, to: r.target, kind: r.kind });
      if (fromMatch && !toMatch && r.kind === "imports") leaks.add(`${r.source} -> ${r.target}`);
    }
    return {
      nodes: [...nodes].toSorted().slice(0, 60),
      edges: edges.slice(0, 80),
      crossBoundaryLeaks: [...leaks].toSorted().slice(0, 30),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function collectGitChangedFiles(repoRoot: string, range?: string): string[] {
  try {
    const args = range
      ? ["-C", repoRoot, "diff", "--name-only", range]
      : ["-C", repoRoot, "status", "--porcelain"];
    const raw = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = raw
      .split(/\r?\n/)
      .map((l) => (range ? l.trim() : l.slice(3).trim()))
      .filter(Boolean);
    return [...new Set(files)].toSorted();
  } catch {
    return [];
  }
}

interface WalkState {
  readonly seen: Set<string>;
  readonly queue: string[];
  readonly added: string[];
}

function enqueueMatchingCallers(
  cur: string,
  rev: ReadonlyMap<string, readonly string[]>,
  state: WalkState,
): void {
  for (const [target, callers] of rev.entries()) {
    if (!target.includes(cur)) continue;
    for (const c of callers) {
      if (state.seen.has(c)) continue;
      state.seen.add(c);
      state.added.push(c);
      state.queue.push(c);
    }
  }
}

function expandTransitiveDependents(repoRoot: string, changedFiles: readonly string[]): string[] {
  const dbPath = findRepoSpecSqlite(repoRoot);
  if (!dbPath || changedFiles.length === 0) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!tables.has("edges")) return [];
    const rows = db.query("SELECT source, target FROM edges WHERE kind = 'imports' LIMIT 4000").all() as Array<{
      source: string;
      target: string;
    }>;
    const rev = new Map<string, string[]>();
    for (const r of rows) {
      const list = rev.get(r.target) ?? [];
      list.push(r.source);
      rev.set(r.target, list);
    }
    const state: WalkState = { seen: new Set<string>(changedFiles), queue: [...changedFiles], added: [] };
    for (let head = 0; head < state.queue.length && state.added.length < 200; head += 1) {
      enqueueMatchingCallers(state.queue[head] ?? "", rev, state);
    }
    return state.added.toSorted();
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function buildFeatureWeights(registry: RegistrySnapshot): {
  readonly invCounts: Map<string, number>;
  readonly bugfixCounts: Map<string, number>;
} {
  const invCounts = new Map<string, number>();
  const bugfixCounts = new Map<string, number>();
  for (const inv of registry.invariants) {
    if (inv.status !== "active") continue;
    invCounts.set(inv.featureId, (invCounts.get(inv.featureId) ?? 0) + 1);
    if (inv.originKind === "bugfix") {
      bugfixCounts.set(inv.featureId, (bugfixCounts.get(inv.featureId) ?? 0) + 1);
    }
  }
  return { invCounts, bugfixCounts };
}

export function selectAffectedTests(
  repoRoot: string,
  registry: RegistrySnapshot,
  range?: string,
  explicitChangedFiles?: readonly string[],
): AffectedTestResult {
  if (!repoRoot) throw new Error("repoRoot is required.");
  const changedFiles = explicitChangedFiles ? [...explicitChangedFiles] : collectGitChangedFiles(repoRoot, range);
  const transitiveFiles = expandTransitiveDependents(repoRoot, changedFiles);
  const impactedSet = new Set([...changedFiles, ...transitiveFiles]);

  const affectedFeatures = new Set<string>();
  const directFeatures = new Set<string>();
  const { invCounts, bugfixCounts } = buildFeatureWeights(registry);

  for (const inv of registry.invariants) {
    if (inv.status !== "active" || !impactedSet.has(inv.file)) continue;
    affectedFeatures.add(inv.featureId);
    if (changedFiles.includes(inv.file)) directFeatures.add(inv.featureId);
  }
  for (const feat of registry.features) {
    if (feat.status !== "active") continue;
    const areaNorm = feat.area.replace(/^plugin:/, "packages/plugins/");
    for (const f of impactedSet) {
      if (f.includes(areaNorm) || f.startsWith(`${feat.area}/`)) {
        affectedFeatures.add(feat.id);
        if (changedFiles.includes(f)) directFeatures.add(feat.id);
      }
    }
  }

  const testScores = new Map<string, { features: Set<string>; score: number; bugfixHits: number; invHits: number }>();
  const addScore = (testPath: string, fid: string, direct: boolean): void => {
    const entry = testScores.get(testPath) ?? { features: new Set<string>(), score: 0, bugfixHits: 0, invHits: 0 };
    if (entry.features.has(fid)) return;
    entry.features.add(fid);
    const invs = invCounts.get(fid) ?? 0;
    const bugs = bugfixCounts.get(fid) ?? 0;
    entry.invHits += invs;
    entry.bugfixHits += bugs;
    entry.score += (direct ? 10 : 4) + bugs * 10 + invs * 2;
    testScores.set(testPath, entry);
  };

  for (const inv of registry.invariants) {
    if (inv.status !== "active" || !inv.rootTestPath || !affectedFeatures.has(inv.featureId)) continue;
    addScore(inv.rootTestPath, inv.featureId, directFeatures.has(inv.featureId));
  }
  for (const link of registry.tests) {
    if (!affectedFeatures.has(link.featureId)) continue;
    addScore(link.testPath, link.featureId, directFeatures.has(link.featureId));
  }

  const prioritizedTests = [...testScores.entries()]
    .map(([testPath, meta]) => ({
      testPath,
      featureIds: [...meta.features].toSorted(),
      score: meta.score,
      reason: `features=${meta.features.size}, invariants=${meta.invHits}, bugfixGuards=${meta.bugfixHits}`,
    }))
    .toSorted((a, b) => (b.score !== a.score ? b.score - a.score : a.testPath.localeCompare(b.testPath)));

  return {
    changedFiles,
    affectedFeatures: [...affectedFeatures].toSorted(),
    transitiveFiles,
    prioritizedTests,
  };
}
