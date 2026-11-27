import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  FeatureRecord,
  FeatureTestLink,
  InvariantRecord,
  RegistryCounts,
  RegistrySnapshot,
} from "@featlock/plugin";
import { countRegistry, findDuplicateFeatures, queryRegistryFeatures } from "./query.ts";
import {
  loadSnapshotFromSql,
  readSnapshotFromDb,
  REGISTRY_DB_REL,
  REGISTRY_SQL_REL,
  SCHEMA_SQL,
  serializeRegistrySql,
} from "./schema.ts";

export { REGISTRY_DB_REL, REGISTRY_SQL_REL };

export interface RecordNewFeatureInput {
  readonly repoRoot: string;
  readonly feature: FeatureRecord;
  readonly tests: readonly FeatureTestLink[];
  readonly invariants?: readonly InvariantRecord[];
  readonly actor?: string;
}

export interface RecordImprovementInput {
  readonly repoRoot: string;
  readonly featureId: string;
  readonly summary: string;
  readonly extraTests?: readonly FeatureTestLink[];
  readonly extraInvariants?: readonly InvariantRecord[];
  readonly actor?: string;
}

function materializeRegistryDb(repoRoot: string): {
  readonly sqlPath: string;
  readonly dbPath: string;
  readonly snapshot: RegistrySnapshot;
  readonly counts: RegistryCounts;
} {
  if (!repoRoot) throw new Error("repoRoot is required to materialize registry database.");
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
    return { sqlPath, dbPath, snapshot, counts: countRegistry(snapshot) };
  } finally {
    db.close();
  }
}

function writeRegistrySql(repoRoot: string, snapshot: RegistrySnapshot): string {
  if (!repoRoot) throw new Error("repoRoot is required to write registry SQL.");
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
  fs.writeFileSync(sqlPath, serializeRegistrySql(snapshot), "utf8");
  return sqlPath;
}

function readRepoRegistry(repoRoot: string): RegistrySnapshot {
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  if (!fs.existsSync(sqlPath)) {
    return { features: [], tests: [], invariants: [], auditLog: [] };
  }
  return loadSnapshotFromSql(fs.readFileSync(sqlPath, "utf8"));
}

function readHeadRegistry(repoRoot: string): RegistrySnapshot | null {
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

function recordNewFeature(input: RecordNewFeatureInput): RegistrySnapshot {
  if (!input.feature.id) throw new Error("Feature id is required.");
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

function recordFeatureImprovement(input: RecordImprovementInput): RegistrySnapshot {
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

export const Registry = {
  sqlRel: REGISTRY_SQL_REL,
  dbRel: REGISTRY_DB_REL,
  serializeSql: serializeRegistrySql,
  loadFromSql: loadSnapshotFromSql,
  readFromDb: readSnapshotFromDb,
  materializeDb: materializeRegistryDb,
  writeSql: writeRegistrySql,
  readRepo: readRepoRegistry,
  readHead: readHeadRegistry,
  count: countRegistry,
  queryFeatures: queryRegistryFeatures,
  findDuplicates: findDuplicateFeatures,
  recordNew: recordNewFeature,
  recordImprovement: recordFeatureImprovement,
};
