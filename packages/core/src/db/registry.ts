import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  DuplicateCandidate,
  FeatureRecord,
  FeatureTestLink,
  InvariantRecord,
  RegistryCounts,
  RegistrySnapshot,
} from "@featlock/plugin";

export const REGISTRY_SQL_REL = "features/registry.sql";
export const REGISTRY_DB_REL = ".featlock/registry.sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated','removed')),
  source TEXT NOT NULL DEFAULT 'manual',
  adr_ref TEXT,
  removal_reason TEXT
);

CREATE TABLE IF NOT EXISTS feature_tests (
  feature_id TEXT NOT NULL REFERENCES features(id),
  test_path TEXT NOT NULL,
  test_pattern TEXT NOT NULL,
  rung TEXT NOT NULL DEFAULT 'R2',
  PRIMARY KEY (feature_id, test_path, test_pattern)
);

CREATE TABLE IF NOT EXISTS invariants (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,
  guard_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated','removed'))
);

CREATE TABLE IF NOT EXISTS feature_audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('added','improved','invariant_added','deprecated','removed')),
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_sha TEXT
);

CREATE TRIGGER IF NOT EXISTS guard_prevent_feature_delete
BEFORE DELETE ON features
WHEN OLD.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'FEATLOCK_TRIGGER_BLOCK: Cannot DELETE active feature directly; mark status=removed with adr_ref and removal_reason.');
END;

CREATE TRIGGER IF NOT EXISTS guard_prevent_feature_test_delete
BEFORE DELETE ON feature_tests
WHEN EXISTS (SELECT 1 FROM features WHERE id = OLD.feature_id AND status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'FEATLOCK_TRIGGER_BLOCK: Cannot unlink test from an active feature without replacing coverage.');
END;

CREATE TRIGGER IF NOT EXISTS guard_prevent_invariant_delete
BEFORE DELETE ON invariants
WHEN OLD.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'FEATLOCK_TRIGGER_BLOCK: Cannot DELETE active invariant directly; mark status=removed with explicit ADR justification.');
END;
`.trim();

function sqlQuote(value: string | undefined | null): string {
  if (value === undefined || value === null) return "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

export function serializeRegistrySql(snapshot: RegistrySnapshot): string {
  const lines: string[] = [SCHEMA_SQL, ""];
  const sortedFeatures = snapshot.features.toSorted((a, b) => a.id.localeCompare(b.id));
  for (const f of sortedFeatures) {
    lines.push(
      `INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES (${sqlQuote(f.id)}, ${sqlQuote(f.area)}, ${sqlQuote(f.name)}, ${sqlQuote(f.summary)}, ${sqlQuote(f.acceptanceCriteria)}, ${sqlQuote(f.status)}, ${sqlQuote(f.source)}, ${sqlQuote(f.adrRef)}, ${sqlQuote(f.removalReason)});`,
    );
  }
  const sortedTests = snapshot.tests.toSorted((a, b) =>
    `${a.featureId}:${a.testPath}:${a.testPattern}`.localeCompare(`${b.featureId}:${b.testPath}:${b.testPattern}`),
  );
  for (const t of sortedTests) {
    lines.push(
      `INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES (${sqlQuote(t.featureId)}, ${sqlQuote(t.testPath)}, ${sqlQuote(t.testPattern)}, ${sqlQuote(t.rung)});`,
    );
  }
  const sortedInvariants = snapshot.invariants.toSorted((a, b) => a.id.localeCompare(b.id));
  for (const inv of sortedInvariants) {
    lines.push(
      `INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status) VALUES (${sqlQuote(inv.id)}, ${sqlQuote(inv.featureId)}, ${sqlQuote(inv.kind)}, ${sqlQuote(inv.statement)}, ${sqlQuote(inv.file)}, ${Math.max(1, Math.floor(inv.line))}, ${Number(inv.confidence.toFixed(3))}, ${sqlQuote(inv.source)}, ${sqlQuote(inv.guardRef)}, ${sqlQuote(inv.status)});`,
    );
  }
  for (const log of snapshot.auditLog) {
    lines.push(
      `INSERT INTO feature_audit_log (feature_id, action, actor, summary, commit_sha) VALUES (${sqlQuote(log.featureId)}, ${sqlQuote(log.action)}, ${sqlQuote(log.actor)}, ${sqlQuote(log.summary)}, ${sqlQuote(log.commitSha)});`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function loadSnapshotFromSql(sqlText: string): RegistrySnapshot {
  const db = new Database(":memory:");
  try {
    db.exec(SCHEMA_SQL);
    if (sqlText.trim().length > 0) db.exec(sqlText);
    return readSnapshotFromDb(db);
  } finally {
    db.close();
  }
}

export function readSnapshotFromDb(db: Database): RegistrySnapshot {
  const fRows = db
    .query("SELECT id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason FROM features ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  const tRows = db
    .query("SELECT feature_id, test_path, test_pattern, rung FROM feature_tests ORDER BY feature_id, test_path, test_pattern")
    .all() as Array<Record<string, unknown>>;
  const iRows = db
    .query("SELECT id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status FROM invariants ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  const aRows = db
    .query("SELECT feature_id, action, actor, summary, commit_sha FROM feature_audit_log ORDER BY seq")
    .all() as Array<Record<string, unknown>>;

  return {
    features: fRows.map((r) => ({
      id: String(r.id ?? ""),
      area: String(r.area ?? ""),
      name: String(r.name ?? ""),
      summary: String(r.summary ?? ""),
      acceptanceCriteria: String(r.acceptance_criteria ?? ""),
      status: (r.status === "deprecated" || r.status === "removed" ? r.status : "active"),
      source: String(r.source ?? "manual"),
      adrRef: typeof r.adr_ref === "string" ? r.adr_ref : undefined,
      removalReason: typeof r.removal_reason === "string" ? r.removal_reason : undefined,
    })),
    tests: tRows.map((r) => ({
      featureId: String(r.feature_id ?? ""),
      testPath: String(r.test_path ?? ""),
      testPattern: String(r.test_pattern ?? ""),
      rung: String(r.rung ?? "R2"),
    })),
    invariants: iRows.map((r) => ({
      id: String(r.id ?? ""),
      featureId: String(r.feature_id ?? ""),
      kind: String(r.kind ?? ""),
      statement: String(r.statement ?? ""),
      file: String(r.file ?? ""),
      line: Number(r.line ?? 1),
      confidence: Number(r.confidence ?? 1),
      source: String(r.source ?? "ast"),
      guardRef: typeof r.guard_ref === "string" ? r.guard_ref : undefined,
      status: (r.status === "deprecated" || r.status === "removed" ? r.status : "active"),
    })),
    auditLog: aRows.map((r) => ({
      featureId: String(r.feature_id ?? ""),
      action: (r.action === "improved" || r.action === "invariant_added" || r.action === "deprecated" || r.action === "removed"
        ? r.action
        : "added"),
      actor: String(r.actor ?? "agent"),
      summary: String(r.summary ?? ""),
      commitSha: typeof r.commit_sha === "string" ? r.commit_sha : undefined,
    })),
  };
}

export function materializeRegistryDb(repoRoot: string): {
  readonly sqlPath: string;
  readonly dbPath: string;
  readonly snapshot: RegistrySnapshot;
  readonly counts: RegistryCounts;
} {
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  const dbPath = path.join(repoRoot, REGISTRY_DB_REL);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    if (fs.existsSync(sqlPath)) {
      const sqlText = fs.readFileSync(sqlPath, "utf8");
      if (sqlText.trim().length > 0) db.exec(sqlText);
    }
    const snapshot = readSnapshotFromDb(db);
    return {
      sqlPath,
      dbPath,
      snapshot,
      counts: countRegistry(snapshot),
    };
  } finally {
    db.close();
  }
}

export function countRegistry(snapshot: RegistrySnapshot): RegistryCounts {
  return {
    features: snapshot.features.length,
    tests: snapshot.tests.length,
    invariants: snapshot.invariants.length,
    auditEntries: snapshot.auditLog.length,
  };
}

export function writeRegistrySql(repoRoot: string, snapshot: RegistrySnapshot): string {
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
  fs.writeFileSync(sqlPath, serializeRegistrySql(snapshot), "utf8");
  return sqlPath;
}

export function readRepoRegistry(repoRoot: string): RegistrySnapshot {
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  if (!fs.existsSync(sqlPath)) {
    return { features: [], tests: [], invariants: [], auditLog: [] };
  }
  return loadSnapshotFromSql(fs.readFileSync(sqlPath, "utf8"));
}

export function readHeadRegistry(repoRoot: string): RegistrySnapshot | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "show", `HEAD:${REGISTRY_SQL_REL}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return loadSnapshotFromSql(out);
  } catch {
    return null;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((tok) => tok.length >= 3);
}

export function queryRegistryFeatures(snapshot: RegistrySnapshot, term: string): FeatureRecord[] {
  const tokens = tokenize(term);
  if (tokens.length === 0) return [...snapshot.features];
  return snapshot.features.filter((f) => {
    const hay = `${f.id} ${f.area} ${f.name} ${f.summary} ${f.acceptanceCriteria}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

export function findDuplicateFeatures(
  snapshot: RegistrySnapshot,
  description: string,
): DuplicateCandidate[] {
  const queryTokens = new Set(tokenize(description));
  if (queryTokens.size === 0) return [];
  const results: DuplicateCandidate[] = [];
  for (const f of snapshot.features) {
    if (f.status === "removed") continue;
    const featTokens = new Set(tokenize(`${f.id} ${f.area} ${f.name} ${f.summary}`));
    const matched: string[] = [];
    for (const tok of queryTokens) {
      if (featTokens.has(tok)) matched.push(tok);
    }
    const unionSize = new Set([...queryTokens, ...featTokens]).size;
    const score = unionSize > 0 ? Number((matched.length / Math.min(queryTokens.size, Math.max(1, featTokens.size))).toFixed(3)) : 0;
    if (matched.length >= 2 || score >= 0.4) {
      results.push({ featureId: f.id, name: f.name, score, matchedTokens: matched });
    }
  }
  return results.toSorted((a, b) => b.score - a.score || a.featureId.localeCompare(b.featureId));
}

export interface RecordNewFeatureInput {
  readonly repoRoot: string;
  readonly feature: FeatureRecord;
  readonly tests: readonly FeatureTestLink[];
  readonly invariants?: readonly InvariantRecord[];
  readonly actor?: string;
}

export function recordNewFeature(input: RecordNewFeatureInput): RegistrySnapshot {
  const current = readRepoRegistry(input.repoRoot);
  const next: RegistrySnapshot = {
    features: [...current.features.filter((f) => f.id !== input.feature.id), input.feature],
    tests: [...current.tests, ...input.tests],
    invariants: [...current.invariants, ...(input.invariants ?? [])],
    auditLog: [
      ...current.auditLog,
      { featureId: input.feature.id, action: "added", actor: input.actor ?? "agent", summary: input.feature.summary },
    ],
  };
  writeRegistrySql(input.repoRoot, next);
  materializeRegistryDb(input.repoRoot);
  return next;
}

export interface RecordImprovementInput {
  readonly repoRoot: string;
  readonly featureId: string;
  readonly summary: string;
  readonly extraTests?: readonly FeatureTestLink[];
  readonly extraInvariants?: readonly InvariantRecord[];
  readonly actor?: string;
}

export function recordFeatureImprovement(input: RecordImprovementInput): RegistrySnapshot {
  const current = readRepoRegistry(input.repoRoot);
  const target = current.features.find((f) => f.id === input.featureId);
  if (!target) {
    throw new Error(`Feature '${input.featureId}' does not exist in ${REGISTRY_SQL_REL}. Use record-new instead.`);
  }
  const updated: FeatureRecord = { ...target, summary: `${target.summary} | ${input.summary}` };
  const next: RegistrySnapshot = {
    features: current.features.map((f) => (f.id === input.featureId ? updated : f)),
    tests: [...current.tests, ...(input.extraTests ?? [])],
    invariants: [...current.invariants, ...(input.extraInvariants ?? [])],
    auditLog: [
      ...current.auditLog,
      { featureId: input.featureId, action: "improved", actor: input.actor ?? "agent", summary: input.summary },
    ],
  };
  writeRegistrySql(input.repoRoot, next);
  materializeRegistryDb(input.repoRoot);
  return next;
}
