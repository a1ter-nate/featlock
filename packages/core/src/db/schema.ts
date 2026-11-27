import { Database } from "bun:sqlite";
import type { RegistrySnapshot } from "@featlock/plugin";

export const REGISTRY_SQL_REL = "features/registry.sql";
export const REGISTRY_DB_REL = ".featlock/registry.sqlite";

export const SCHEMA_SQL = `
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
  if (!snapshot) throw new Error("RegistrySnapshot is required.");
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

export function readSnapshotFromDb(db: Database): RegistrySnapshot {
  if (!db) throw new Error("SQLite Database instance is required.");
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
      status: r.status === "deprecated" || r.status === "removed" ? r.status : "active",
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
      status: r.status === "deprecated" || r.status === "removed" ? r.status : "active",
    })),
    auditLog: aRows.map((r) => ({
      featureId: String(r.feature_id ?? ""),
      action:
        r.action === "improved" || r.action === "invariant_added" || r.action === "deprecated" || r.action === "removed"
          ? r.action
          : "added",
      actor: String(r.actor ?? "agent"),
      summary: String(r.summary ?? ""),
      commitSha: typeof r.commit_sha === "string" ? r.commit_sha : undefined,
    })),
  };
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
