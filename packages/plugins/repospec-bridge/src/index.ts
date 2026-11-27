import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  Plugin,
  type ExtractionOutput,
  type FeatureRecord,
  type FeatureTestLink,
  type InvariantRecord,
  type ScanContext,
} from "@featlock/plugin";

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function findRepoSpecDb(repoRoot: string): string | null {
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

function findRepoSpecJson(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, "repospec.json"),
    path.join(repoRoot, ".repospec", "repospec.json"),
    path.join(repoRoot, "out", path.basename(repoRoot), "repospec.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function extractFromSqlite(dbPath: string): ExtractionOutput {
  const db = new Database(dbPath, { readonly: true });
  const features: FeatureRecord[] = [];
  const tests: FeatureTestLink[] = [];
  const invariants: InvariantRecord[] = [];
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (tables.has("module_cards")) {
      const rows = db.query("SELECT id, name, unit FROM module_cards ORDER BY id LIMIT 60").all() as Array<{
        id: string;
        name: string;
        unit: string;
      }>;
      for (const r of rows) {
        features.push({
          id: `feat.rs.${slugify(r.id)}`,
          area: r.unit || "repospec",
          name: r.name || r.id,
          summary: `RepoSpec compiled module '${r.id}' in unit '${r.unit}'.`,
          acceptanceCriteria: `Module boundary and public API of '${r.id}' remain intact with zero RepoSpec invariant regressions.`,
          status: "active",
          source: "repospec",
        });
      }
    }
    if (tables.has("invariants")) {
      const rows = db.query("SELECT id, name, statement, status FROM invariants ORDER BY id LIMIT 60").all() as Array<{
        id: string;
        name: string;
        statement?: string;
        status?: string;
      }>;
      for (const r of rows) {
        invariants.push({
          id: `inv:repospec:${slugify(r.id)}`,
          featureId: features[0]?.id ?? "feat.repospec-architecture",
          kind: "repospec-sql-invariant",
          statement: r.statement || r.name || r.id,
          file: path.basename(dbPath),
          line: 1,
          confidence: 0.95,
          source: "repospec",
          guardRef: r.id,
          status: "active",
        });
      }
    }
  } finally {
    db.close();
  }
  return { features, tests, invariants };
}

function extractFromJson(jsonPath: string): ExtractionOutput {
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
    surfaces?: { endpoints?: Array<{ method?: string; path?: string; file?: string }> };
    invariants?: Array<{ id: string; name?: string; statement?: string }>;
    stateMachines?: Array<{ id?: string; name?: string; file?: string; line?: number }>;
  };
  const features: FeatureRecord[] = [];
  const invariants: InvariantRecord[] = [];

  for (const ep of (raw.surfaces?.endpoints ?? []).slice(0, 40)) {
    const key = `${ep.method ?? "GET"} ${ep.path ?? "/"}`;
    features.push({
      id: `feat.http.${slugify(key)}`,
      area: "http-surface",
      name: `HTTP ${key}`,
      summary: `RepoSpec reconciled HTTP surface ${key}${ep.file ? ` (${ep.file})` : ""}.`,
      acceptanceCriteria: `Endpoint ${key} preserves contract shape and handler provenance.`,
      status: "active",
      source: "repospec",
    });
  }
  for (const sm of (raw.stateMachines ?? []).slice(0, 40)) {
    const name = sm.name ?? sm.id ?? "state-machine";
    invariants.push({
      id: `inv:repospec:sm:${slugify(name)}`,
      featureId: features[0]?.id ?? "feat.repospec-architecture",
      kind: "state-machine",
      statement: `State machine '${name}' preserves declared transitions and guards.`,
      file: sm.file ?? "repospec.json",
      line: sm.line ?? 1,
      confidence: 0.92,
      source: "repospec",
      status: "active",
    });
  }
  for (const inv of (raw.invariants ?? []).slice(0, 60)) {
    invariants.push({
      id: `inv:repospec:${slugify(inv.id)}`,
      featureId: features[0]?.id ?? "feat.repospec-architecture",
      kind: "repospec-sql-invariant",
      statement: inv.statement ?? inv.name ?? inv.id,
      file: path.basename(jsonPath),
      line: 1,
      confidence: 0.95,
      source: "repospec",
      guardRef: inv.id,
      status: "active",
    });
  }
  return { features, tests: [], invariants };
}

function extractRepoSpecArtifacts(ctx: ScanContext): ExtractionOutput {
  const dbPath = findRepoSpecDb(ctx.repoRoot);
  if (dbPath) return extractFromSqlite(dbPath);
  const jsonPath = findRepoSpecJson(ctx.repoRoot);
  if (jsonPath) return extractFromJson(jsonPath);

  const sqlRuleFiles = ctx.files.filter((f) => f.ext === ".sql" && /(?:^|\/)rules\//.test(f.rel));
  const invariants: InvariantRecord[] = [];
  for (const rf of sqlRuleFiles) {
    const idMatch = /@id:\s*([^\n]+)/.exec(rf.content);
    const stmtMatch = /@statement:\s*([^\n]+)/.exec(rf.content);
    if (!idMatch?.[1]) continue;
    invariants.push({
      id: `inv:repospec-rule:${slugify(idMatch[1].trim())}`,
      featureId: "feat.repospec-rules",
      kind: "repospec-sql-rule",
      statement: (stmtMatch?.[1] ?? idMatch[1]).trim(),
      file: rf.rel,
      line: 1,
      confidence: 0.96,
      source: "repospec",
      guardRef: rf.rel,
      status: "active",
    });
  }
  return { features: [], tests: [], invariants };
}

export default Plugin.define({
  id: "featlock.repospec-bridge",
  async setup(ctx) {
    await ctx.extractor.transform((ed) => {
      ed.add({
        id: "featlock.repospec-bridge.extractor",
        label: "RepoSpec SQLite/JSON/SQL-Rule Bridge",
        extract: extractRepoSpecArtifacts,
      });
    });
    await ctx.invariantScanner.transform((ed) => {
      ed.add({
        id: "featlock.repospec-bridge.invariants",
        source: "repospec",
        scan: (scanCtx) => extractRepoSpecArtifacts(scanCtx).invariants,
      });
    });
  },
});
