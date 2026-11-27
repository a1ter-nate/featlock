// @bun
// packages/core/src/db/registry.ts
import { Database as Database2 } from "bun:sqlite";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// packages/core/src/db/query.ts
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((tok) => tok.length >= 3);
}
function countRegistry(snapshot) {
  return {
    features: snapshot.features.length,
    tests: snapshot.tests.length,
    invariants: snapshot.invariants.length,
    auditEntries: snapshot.auditLog.length
  };
}
function queryRegistryFeatures(snapshot, term) {
  const tokens = tokenize(term);
  if (tokens.length === 0)
    return [...snapshot.features];
  return snapshot.features.filter((f) => {
    const hay = `${f.id} ${f.area} ${f.name} ${f.summary} ${f.acceptanceCriteria}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}
function findDuplicateFeatures(snapshot, description) {
  const queryTokens = new Set(tokenize(description));
  if (queryTokens.size === 0)
    return [];
  const results = [];
  for (const f of snapshot.features) {
    if (f.status === "removed")
      continue;
    const featTokens = new Set(tokenize(`${f.id} ${f.area} ${f.name} ${f.summary}`));
    const matched = [];
    for (const tok of queryTokens) {
      if (featTokens.has(tok))
        matched.push(tok);
    }
    const denom = Math.min(queryTokens.size, Math.max(1, featTokens.size));
    const score = Number((matched.length / denom).toFixed(3));
    if (matched.length >= 2 || score >= 0.4) {
      results.push({ featureId: f.id, name: f.name, score, matchedTokens: matched });
    }
  }
  return results.toSorted((a, b) => {
    const diff = b.score - a.score;
    return diff !== 0 ? diff : a.featureId.localeCompare(b.featureId);
  });
}

// packages/core/src/db/schema.ts
import { Database } from "bun:sqlite";
var REGISTRY_SQL_REL = "features/registry.sql";
var REGISTRY_DB_REL = ".featlock/registry.sqlite";
var SCHEMA_SQL = `
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
  guard_anchor TEXT,
  root_test_path TEXT,
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
function sqlQuote(value) {
  if (value === undefined || value === null)
    return "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}
function serializeRegistrySql(snapshot) {
  if (!snapshot)
    throw new Error("RegistrySnapshot is required.");
  const lines = [SCHEMA_SQL, ""];
  const sortedFeatures = snapshot.features.toSorted((a, b) => a.id.localeCompare(b.id));
  for (const f of sortedFeatures) {
    lines.push(`INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES (${sqlQuote(f.id)}, ${sqlQuote(f.area)}, ${sqlQuote(f.name)}, ${sqlQuote(f.summary)}, ${sqlQuote(f.acceptanceCriteria)}, ${sqlQuote(f.status)}, ${sqlQuote(f.source)}, ${sqlQuote(f.adrRef)}, ${sqlQuote(f.removalReason)});`);
  }
  const sortedTests = snapshot.tests.toSorted((a, b) => `${a.featureId}:${a.testPath}:${a.testPattern}`.localeCompare(`${b.featureId}:${b.testPath}:${b.testPattern}`));
  for (const t of sortedTests) {
    lines.push(`INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES (${sqlQuote(t.featureId)}, ${sqlQuote(t.testPath)}, ${sqlQuote(t.testPattern)}, ${sqlQuote(t.rung)});`);
  }
  const sortedInvariants = snapshot.invariants.toSorted((a, b) => a.id.localeCompare(b.id));
  for (const inv of sortedInvariants) {
    lines.push(`INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, guard_anchor, root_test_path, status) VALUES (${sqlQuote(inv.id)}, ${sqlQuote(inv.featureId)}, ${sqlQuote(inv.kind)}, ${sqlQuote(inv.statement)}, ${sqlQuote(inv.file)}, ${Math.max(1, Math.floor(inv.line))}, ${Number(inv.confidence.toFixed(3))}, ${sqlQuote(inv.source)}, ${sqlQuote(inv.guardRef)}, ${sqlQuote(inv.guardAnchor)}, ${sqlQuote(inv.rootTestPath)}, ${sqlQuote(inv.status)});`);
  }
  for (const log of snapshot.auditLog) {
    lines.push(`INSERT INTO feature_audit_log (feature_id, action, actor, summary, commit_sha) VALUES (${sqlQuote(log.featureId)}, ${sqlQuote(log.action)}, ${sqlQuote(log.actor)}, ${sqlQuote(log.summary)}, ${sqlQuote(log.commitSha)});`);
  }
  return `${lines.join(`
`)}
`;
}
function ensureInvariantColumns(db) {
  const cols = new Set(db.query("PRAGMA table_info(invariants)").all().map((c) => c.name));
  if (!cols.has("guard_anchor"))
    db.exec("ALTER TABLE invariants ADD COLUMN guard_anchor TEXT;");
  if (!cols.has("root_test_path"))
    db.exec("ALTER TABLE invariants ADD COLUMN root_test_path TEXT;");
}
function readSnapshotFromDb(db) {
  if (!db)
    throw new Error("SQLite Database instance is required.");
  ensureInvariantColumns(db);
  const fRows = db.query("SELECT id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason FROM features ORDER BY id").all();
  const tRows = db.query("SELECT feature_id, test_path, test_pattern, rung FROM feature_tests ORDER BY feature_id, test_path, test_pattern").all();
  const iRows = db.query("SELECT id, feature_id, kind, statement, file, line, confidence, source, guard_ref, guard_anchor, root_test_path, status FROM invariants ORDER BY id").all();
  const aRows = db.query("SELECT feature_id, action, actor, summary, commit_sha FROM feature_audit_log ORDER BY seq").all();
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
      removalReason: typeof r.removal_reason === "string" ? r.removal_reason : undefined
    })),
    tests: tRows.map((r) => ({
      featureId: String(r.feature_id ?? ""),
      testPath: String(r.test_path ?? ""),
      testPattern: String(r.test_pattern ?? ""),
      rung: String(r.rung ?? "R2")
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
      guardAnchor: typeof r.guard_anchor === "string" ? r.guard_anchor : undefined,
      rootTestPath: typeof r.root_test_path === "string" ? r.root_test_path : undefined,
      status: r.status === "deprecated" || r.status === "removed" ? r.status : "active"
    })),
    auditLog: aRows.map((r) => ({
      featureId: String(r.feature_id ?? ""),
      action: r.action === "improved" || r.action === "invariant_added" || r.action === "deprecated" || r.action === "removed" ? r.action : "added",
      actor: String(r.actor ?? "agent"),
      summary: String(r.summary ?? ""),
      commitSha: typeof r.commit_sha === "string" ? r.commit_sha : undefined
    }))
  };
}
function loadSnapshotFromSql(sqlText) {
  const db = new Database(":memory:");
  try {
    db.exec(SCHEMA_SQL);
    if (sqlText.trim().length > 0)
      db.exec(sqlText);
    return readSnapshotFromDb(db);
  } finally {
    db.close();
  }
}

// packages/core/src/db/registry.ts
function materializeRegistryDb(repoRoot) {
  if (!repoRoot)
    throw new Error("repoRoot is required to materialize registry database.");
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  const dbPath = path.join(repoRoot, REGISTRY_DB_REL);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath))
    fs.rmSync(dbPath, { force: true });
  const db = new Database2(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    if (fs.existsSync(sqlPath)) {
      const sqlText = fs.readFileSync(sqlPath, "utf8");
      if (sqlText.trim().length > 0)
        db.exec(sqlText);
    }
    const snapshot = readSnapshotFromDb(db);
    return { sqlPath, dbPath, snapshot, counts: countRegistry(snapshot) };
  } finally {
    db.close();
  }
}
function writeRegistrySql(repoRoot, snapshot) {
  if (!repoRoot)
    throw new Error("repoRoot is required to write registry SQL.");
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
  fs.writeFileSync(sqlPath, serializeRegistrySql(snapshot), "utf8");
  return sqlPath;
}
function readRepoRegistry(repoRoot) {
  const sqlPath = path.join(repoRoot, REGISTRY_SQL_REL);
  if (!fs.existsSync(sqlPath)) {
    return { features: [], tests: [], invariants: [], auditLog: [] };
  }
  return loadSnapshotFromSql(fs.readFileSync(sqlPath, "utf8"));
}
function readHeadRegistry(repoRoot) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "show", `HEAD:${REGISTRY_SQL_REL}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return loadSnapshotFromSql(out);
  } catch {
    return null;
  }
}
function recordNewFeature(input) {
  if (!input.feature.id)
    throw new Error("Feature id is required.");
  const current = readRepoRegistry(input.repoRoot);
  const next = {
    features: [...current.features.filter((f) => f.id !== input.feature.id), input.feature],
    tests: [...current.tests, ...input.tests],
    invariants: [...current.invariants, ...input.invariants ?? []],
    auditLog: [
      ...current.auditLog,
      { featureId: input.feature.id, action: "added", actor: input.actor ?? "agent", summary: input.feature.summary }
    ]
  };
  writeRegistrySql(input.repoRoot, next);
  materializeRegistryDb(input.repoRoot);
  return next;
}
function recordFeatureImprovement(input) {
  const current = readRepoRegistry(input.repoRoot);
  const target = current.features.find((f) => f.id === input.featureId);
  if (!target) {
    throw new Error(`Feature '${input.featureId}' does not exist in ${REGISTRY_SQL_REL}. Use record-new instead.`);
  }
  const updated = { ...target, summary: `${target.summary} | ${input.summary}` };
  const next = {
    features: current.features.map((f) => f.id === input.featureId ? updated : f),
    tests: [...current.tests, ...input.extraTests ?? []],
    invariants: [...current.invariants, ...input.extraInvariants ?? []],
    auditLog: [
      ...current.auditLog,
      { featureId: input.featureId, action: "improved", actor: input.actor ?? "agent", summary: input.summary }
    ]
  };
  writeRegistrySql(input.repoRoot, next);
  materializeRegistryDb(input.repoRoot);
  return next;
}
var Registry = {
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
  recordImprovement: recordFeatureImprovement
};
// packages/core/src/discover.ts
import { execFileSync as execFileSync2 } from "child_process";
import fs2 from "fs";
import path2 from "path";
var SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  ".featlock",
  ".next",
  ".turbo",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "vendor",
  "bin",
  "obj"
]);
var SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".py", ".rs", ".cs", ".go", ".sql"]);
var NON_LIVE_TEST_RE = /(?:^|\/)(?:examples|fixtures|templates|caught|testdata|snapshots)\//i;
function isTestPath(rel) {
  if (NON_LIVE_TEST_RE.test(rel))
    return false;
  return /(?:^|\/)(?:tests?|__tests__|spec|caddytest|testmocks)\//i.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(rel) || /(?:^|\/)test_[^/]+\.py$/i.test(rel) || /_test\.(?:py|rs|go)$/i.test(rel) || /Tests?\.cs$/i.test(rel);
}
function discoverRepo(repoDir) {
  const repoRoot = path2.resolve(repoDir);
  if (!fs2.existsSync(repoRoot)) {
    throw new Error(`Repository directory does not exist: ${repoRoot}`);
  }
  const allRelPaths = [];
  const files = [];
  const textCache = new Map;
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current)
      continue;
    for (const entry of fs2.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name))
        continue;
      const abs = path2.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        const rel = path2.relative(repoRoot, abs).split(path2.sep).join("/");
        allRelPaths.push(rel);
        const ext = path2.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext))
          continue;
        const stat = fs2.statSync(abs);
        if (stat.size > 512000)
          continue;
        const content = fs2.readFileSync(abs, "utf8");
        textCache.set(rel, content);
        files.push({
          rel,
          abs,
          ext,
          isTest: isTestPath(rel),
          content,
          lines: content.length === 0 ? 0 : content.split(`
`).length
        });
      }
    }
  }
  allRelPaths.sort();
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const readText = (relPath) => {
    const hit = textCache.get(relPath) ?? undefined;
    if (textCache.has(relPath))
      return hit ?? null;
    const abs = path2.join(repoRoot, relPath);
    if (!fs2.existsSync(abs) || !fs2.statSync(abs).isFile()) {
      textCache.set(relPath, null);
      return null;
    }
    const content = fs2.readFileSync(abs, "utf8");
    textCache.set(relPath, content);
    return content;
  };
  return { repoRoot, files, allRelPaths, readText };
}
function listStagedFiles(repoRoot) {
  try {
    const out = execFileSync2("git", ["-C", repoRoot, "diff", "--cached", "--name-only"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
// packages/core/src/plugin/host.ts
import fs7 from "fs";
import path9 from "path";
import { pathToFileURL } from "url";

// packages/plugin/src/index.ts
function definePlugin(def) {
  if (!def.id || def.id.trim().length === 0) {
    throw new Error("Plugin id must be a non-empty string.");
  }
  return {
    _tag: "FeatlockPlugin",
    id: def.id.trim(),
    guarded: def.guarded === true,
    setup: def.setup
  };
}
function isFeatlockPlugin(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const rec = value;
  return typeof rec.id === "string" && rec.id.length > 0 && typeof rec.setup === "function";
}
var Plugin = {
  define: definePlugin
};

// packages/core/src/state.ts
var activeGroup;
var activeBatch;
function withGroup(report, fn) {
  const prev = activeGroup;
  const grp = { failed: false, registrations: new Set, report };
  activeGroup = grp;
  try {
    return { group: grp, result: fn() };
  } finally {
    activeGroup = prev;
  }
}
async function withGroupAsync(report, fn) {
  const prev = activeGroup;
  const grp = { failed: false, registrations: new Set, report };
  activeGroup = grp;
  try {
    const result = await fn();
    return { group: grp, result };
  } finally {
    activeGroup = prev;
  }
}
function detachGroup(grp, failure) {
  if (grp.failed)
    return;
  grp.failed = true;
  const toNotify = new Set;
  for (const reg of grp.registrations) {
    reg.remove();
    toNotify.add(reg.notify);
  }
  grp.registrations.clear();
  grp.report(failure);
  for (const notify of toNotify)
    notify();
}
function batch(fn) {
  if (activeBatch?.active)
    return fn();
  const prev = activeBatch;
  const current = { active: true, pending: new Set };
  activeBatch = current;
  try {
    const out = fn();
    current.active = false;
    for (const notify of current.pending)
      notify();
    return out;
  } finally {
    current.active = false;
    activeBatch = prev;
  }
}
function createState(options) {
  if (!options)
    throw new Error("StateOptions are required.");
  let cached = options.initial();
  let dirty = false;
  let rev = 0;
  const transforms = new Set;
  const invalidate = () => {
    dirty = true;
    rev += 1;
  };
  const get = () => {
    if (!dirty)
      return cached;
    for (let attempt = 0;attempt < 32; attempt += 1) {
      const startRev = rev;
      const next = options.initial();
      const editor = options.editor(next);
      for (const entry of Array.from(transforms)) {
        try {
          entry.run(editor);
        } catch (cause) {
          if (!entry.group)
            throw cause;
          detachGroup(entry.group, { state: options.name ?? "anonymous", cause });
        }
        if (rev !== startRev)
          break;
      }
      if (rev !== startRev)
        continue;
      cached = next;
      dirty = false;
      return cached;
    }
    dirty = false;
    return cached;
  };
  const notifyNow = () => {
    const value = get();
    if (options.notify)
      options.notify(value);
  };
  const markChanged = () => {
    invalidate();
    if (activeBatch?.active) {
      activeBatch.pending.add(notifyNow);
      return;
    }
    notifyNow();
  };
  const transform = (cb) => {
    const grp = activeGroup;
    if (grp?.failed)
      return { dispose: () => {
        return;
      } };
    const entry = { run: cb, group: grp };
    transforms.add(entry);
    const remove = () => {
      if (transforms.delete(entry))
        invalidate();
    };
    const grouped = { remove, notify: notifyNow };
    if (grp)
      grp.registrations.add(grouped);
    markChanged();
    return {
      dispose: () => {
        if (grp)
          grp.registrations.delete(grouped);
        if (transforms.delete(entry))
          markChanged();
      }
    };
  };
  return { get, transform, reload: markChanged, invalidate, revision: () => rev };
}
function createKeyedDomainState(name) {
  return createState({
    name,
    initial: () => [],
    editor: (draft) => ({
      list: () => [...draft],
      get: (id) => draft.find((item) => item.id === id),
      add: (item) => {
        const idx = draft.findIndex((existing) => existing.id === item.id);
        if (idx >= 0)
          draft[idx] = item;
        else
          draft.push(item);
      },
      update: (id, fn) => {
        const target = draft.find((item) => item.id === id);
        if (target)
          fn(target);
      },
      remove: (id) => {
        const idx = draft.findIndex((item) => item.id === id);
        if (idx >= 0)
          draft.splice(idx, 1);
      }
    })
  });
}
var State = {
  create: createState,
  createKeyedDomain: createKeyedDomainState,
  batch,
  group: withGroup,
  groupAsync: withGroupAsync,
  detachGroup
};

// packages/plugins/anti-deletion-guard/src/index.ts
import fs3 from "fs";
import path3 from "path";
var SKIPPED_TEST_RE = /^\s*(?:test|it|describe)\.(?:skip|todo)\s*\(/m;
function normalizeWhitespace(raw) {
  return raw.replace(/\s+/g, " ").trim();
}
function checkActiveFeatureCoverage(ctx) {
  if (!ctx.repoRoot)
    throw new Error("CheckContext.repoRoot is required.");
  const violations = [];
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
        fix: `Link at least one real test file to '${feat.id}' via 'featlock record-improvement'.`
      });
      continue;
    }
    for (const link of linked) {
      const abs = path3.join(ctx.repoRoot, link.testPath);
      if (!fs3.existsSync(abs)) {
        violations.push({
          id: `FLK:missing-test:${feat.id}:${link.testPath}`,
          rule: "linked-test-must-exist",
          severity: "error",
          featureId: feat.id,
          file: link.testPath,
          message: `Feature '${feat.id}' references missing test file '${link.testPath}'.`,
          fix: `Restore '${link.testPath}' or update feature_tests with a live replacement test.`
        });
        continue;
      }
      const content = fs3.readFileSync(abs, "utf8");
      if (SKIPPED_TEST_RE.test(content)) {
        violations.push({
          id: `FLK:skipped-test:${feat.id}:${link.testPath}`,
          rule: "linked-test-not-skipped",
          severity: "warn",
          featureId: feat.id,
          file: link.testPath,
          message: `Linked test file '${link.testPath}' for feature '${feat.id}' contains skipped/todo tests.`,
          fix: "Remove .skip / .todo so feature coverage executes on every run."
        });
      }
    }
  }
  return violations;
}
function checkInvariantLiveness(ctx) {
  if (!ctx.repoRoot)
    throw new Error("CheckContext.repoRoot is required.");
  const violations = [];
  const fileNormCache = new Map;
  const readNormalized = (rel) => {
    const cached = fileNormCache.get(rel);
    if (cached !== undefined)
      return cached;
    const abs = path3.join(ctx.repoRoot, rel);
    if (!fs3.existsSync(abs))
      return null;
    const norm = normalizeWhitespace(fs3.readFileSync(abs, "utf8"));
    fileNormCache.set(rel, norm);
    return norm;
  };
  for (const inv of ctx.registry.invariants) {
    if (inv.status !== "active")
      continue;
    const normContent = readNormalized(inv.file);
    if (normContent === null) {
      violations.push({
        id: `FLK:orphan-invariant:${inv.id}`,
        rule: "invariant-target-must-exist",
        severity: "error",
        featureId: inv.featureId,
        file: inv.file,
        message: `Active invariant '${inv.id}' points to missing file '${inv.file}'.`,
        fix: "Restore the guarded file or migrate the invariant to its new home with an audit entry."
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
          fix: `Restore the guard in '${inv.file}'${inv.rootTestPath ? ` and verify '${inv.rootTestPath}'` : ""}, or formally retire the invariant with an ADR + ALLOW_FEATURE_REMOVAL=1.`
        });
      }
    }
    if (inv.rootTestPath && !fs3.existsSync(path3.join(ctx.repoRoot, inv.rootTestPath))) {
      violations.push({
        id: `FLK:missing-root-test:${inv.id}`,
        rule: "invariant-root-test-missing",
        severity: "error",
        featureId: inv.featureId,
        file: inv.rootTestPath,
        message: `Active invariant '${inv.id}' root test '${inv.rootTestPath}' is missing.`,
        fix: `Restore '${inv.rootTestPath}' or re-bind the invariant to a live root test.`
      });
    }
  }
  return violations;
}
function checkGitAntiDeletion(ctx) {
  if (!ctx.previousRegistry)
    return [];
  const violations = [];
  const currentById = new Map(ctx.registry.features.map((f) => [f.id, f]));
  const currentInvById = new Map(ctx.registry.invariants.map((i) => [i.id, i]));
  for (const prev of ctx.previousRegistry.features) {
    if (prev.status !== "active")
      continue;
    const cur = currentById.get(prev.id);
    if (!cur) {
      violations.push({
        id: `FLK:feature-deleted:${prev.id}`,
        rule: "no-silent-feature-deletion",
        severity: "error",
        featureId: prev.id,
        file: "features/registry.sql",
        message: `BLOCKED: Active feature '${prev.id}' (${prev.name}) was deleted from features/registry.sql.`,
        fix: "Keep the feature active, or mark status='removed' with an explicit adr_ref + removal_reason AND ALLOW_FEATURE_REMOVAL=1."
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
          fix: "Confirm intentional feature removal with the user, document adr_ref + removal_reason, and rerun with ALLOW_FEATURE_REMOVAL=1."
        });
      } else {
        violations.push({
          id: `FLK:loud-removal-warning:${prev.id}`,
          rule: "loud-feature-removal-warning",
          severity: "warn",
          featureId: prev.id,
          file: "features/registry.sql",
          message: `LOUD WARNING: Feature '${prev.id}' (${prev.name}) is being REMOVED under ADR '${cur.adrRef}' (${cur.removalReason}).`,
          fix: "Double-check with the human owner before merging intentional feature removal."
        });
      }
    }
  }
  for (const prevInv of ctx.previousRegistry.invariants) {
    if (prevInv.status !== "active")
      continue;
    const curInv = currentInvById.get(prevInv.id);
    if (!curInv || curInv.status === "removed" && !ctx.allowRemoval) {
      violations.push({
        id: `FLK:invariant-deleted:${prevInv.id}`,
        rule: "no-silent-invariant-deletion",
        severity: "error",
        featureId: prevInv.featureId,
        file: "features/registry.sql",
        message: `BLOCKED: Active invariant '${prevInv.id}' (${prevInv.statement}) was deleted or disabled without ALLOW_FEATURE_REMOVAL=1.`,
        fix: "Restore the invariant or explicitly approve its deprecation with an ADR."
      });
    }
  }
  return violations;
}
function checkVanishedFeatures(ctx) {
  if (ctx.allowRemoval || ctx.registry.features.length === 0)
    return [];
  const liveFeatureIds = new Set(ctx.liveExtraction.features.map((f) => f.id));
  if (liveFeatureIds.size === 0)
    return [];
  const violations = [];
  for (const feat of ctx.registry.features) {
    if (feat.status !== "active" || feat.source !== "ast")
      continue;
    if (liveFeatureIds.has(feat.id))
      continue;
    violations.push({
      id: `FLK:feature-vanished:${feat.id}`,
      rule: "feature-removed-from-code",
      severity: "error",
      featureId: feat.id,
      file: "features/registry.sql",
      message: `BLOCKED: Active extracted feature '${feat.id}' (${feat.name}) vanished from the codebase without ADR retirement.`,
      fix: `Restore the '${feat.area}' source files or formally retire '${feat.id}' with adr_ref + removal_reason and ALLOW_FEATURE_REMOVAL=1.`
    });
  }
  return violations;
}
function checkLiveExtractionDrift(ctx) {
  if (ctx.registry.features.length === 0)
    return [];
  const violations = [];
  const severity = ctx.strictDrift ? "error" : "warn";
  const regFeatureIds = new Set(ctx.registry.features.map((f) => f.id));
  const regInvIds = new Set(ctx.registry.invariants.map((i) => i.id));
  const regAnchors = new Set(ctx.registry.invariants.filter((i) => i.guardAnchor).map((i) => `${i.file}|${normalizeWhitespace(i.guardAnchor ?? "")}`));
  for (const liveFeat of ctx.liveExtraction.features) {
    if (regFeatureIds.has(liveFeat.id))
      continue;
    violations.push({
      id: `FLK:new-feature:${liveFeat.id}`,
      rule: "unrecorded-new-feature",
      severity,
      featureId: liveFeat.id,
      file: "features/registry.sql",
      message: `Unrecorded new feature '${liveFeat.id}' (${liveFeat.name}) detected in codebase.`,
      fix: `Run 'featlock extract --write' or 'featlock record-new --id ${liveFeat.id}' to lock this feature into features/registry.sql.`
    });
  }
  const regTestKeys = new Set(ctx.registry.tests.map((t) => `${t.featureId}|${t.testPath}`));
  for (const liveTest of ctx.liveExtraction.tests) {
    if (!regFeatureIds.has(liveTest.featureId))
      continue;
    if (regTestKeys.has(`${liveTest.featureId}|${liveTest.testPath}`))
      continue;
    violations.push({
      id: `FLK:new-test:${liveTest.featureId}:${liveTest.testPath}`,
      rule: "unrecorded-new-feature-test",
      severity,
      featureId: liveTest.featureId,
      file: liveTest.testPath,
      message: `Unrecorded new capability test '${liveTest.testPath}' linked to '${liveTest.featureId}'.`,
      fix: `Run 'featlock extract --write' or 'featlock record-improvement --id ${liveTest.featureId} --test ${liveTest.testPath}' to save it.`
    });
  }
  for (const liveInv of ctx.liveExtraction.invariants) {
    if (liveInv.source !== "ast" || !liveInv.guardAnchor)
      continue;
    const anchorKey = `${liveInv.file}|${normalizeWhitespace(liveInv.guardAnchor)}`;
    if (regInvIds.has(liveInv.id) || regAnchors.has(anchorKey))
      continue;
    const rootHint = liveInv.rootTestPath ? ` (root test: ${liveInv.rootTestPath})` : "";
    violations.push({
      id: `FLK:new-invariant:${liveInv.id}`,
      rule: "unrecorded-new-invariant",
      severity,
      featureId: liveInv.featureId,
      file: liveInv.file,
      message: `Unrecorded new invariant '${liveInv.id}' in '${liveInv.file}:${liveInv.line}'${rootHint}: ${liveInv.statement}`,
      fix: "Run 'featlock extract --write' or 'featlock record-improvement' to save this invariant in features/registry.sql."
    });
  }
  return violations;
}
function checkStagedDiffRecorded(ctx) {
  if (ctx.stagedFiles.length === 0)
    return [];
  const touchesCodeOrTests = ctx.stagedFiles.some((f) => /\.(?:ts|tsx|js|mjs|py|rs|cs|go)$/.test(f));
  const touchesRegistry = ctx.stagedFiles.includes("features/registry.sql");
  if (!touchesCodeOrTests || touchesRegistry)
    return [];
  return [
    {
      id: "FLK:staged-unrecorded",
      rule: "staged-changes-record-feature",
      severity: "warn",
      file: "features/registry.sql",
      message: "Staged code/test changes have no matching new feature or 'improved' audit entry in features/registry.sql.",
      fix: "Run 'featlock record-new' or 'featlock record-improvement' before committing."
    }
  ];
}
var src_default = Plugin.define({
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
          ...checkVanishedFeatures(checkCtx),
          ...checkLiveExtractionDrift(checkCtx),
          ...checkStagedDiffRecorded(checkCtx)
        ]
      });
    });
  }
});

// packages/plugins/ast-scanner/src/index.ts
import path5 from "path";

// packages/plugins/ast-scanner/src/polyglot.ts
import { parseSync } from "oxc-parser";

// packages/plugins/ast-scanner/src/lexical.ts
var PY_EXT = ".py";
var SINGLE_QUOTE_STRING_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".py"]);
var BACKTICK_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".go"]);
function pushSpaces(out, ch) {
  out.push(ch === `
` ? `
` : " ");
}
function consumeQuoted(src, start, quote, out) {
  out.push(quote);
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "\\" && i + 1 < src.length) {
      pushSpaces(out, ch);
      pushSpaces(out, src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === quote) {
      out.push(quote);
      return i + 1;
    }
    if (ch === `
` && quote !== "`") {
      out.push(`
`);
      return i + 1;
    }
    pushSpaces(out, ch);
    i += 1;
  }
  return i;
}
function consumeTripleQuote(src, start, quote, out) {
  out.push(quote, quote, quote);
  let i = start + 3;
  while (i < src.length) {
    if (src.startsWith(quote.repeat(3), i)) {
      out.push(quote, quote, quote);
      return i + 3;
    }
    const ch = src[i] ?? "";
    if (ch === "\\" && i + 1 < src.length) {
      pushSpaces(out, ch);
      pushSpaces(out, src[i + 1] ?? "");
      i += 2;
      continue;
    }
    pushSpaces(out, ch);
    i += 1;
  }
  return i;
}
function maskPython(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "#") {
      while (i < src.length && src[i] !== `
`) {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && src.startsWith(ch.repeat(3), i)) {
      i = consumeTripleQuote(src, i, ch, out);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = consumeQuoted(src, i, ch, out);
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}
function maskCLike(src, ext) {
  if (!ext)
    throw new Error("File extension is required for lexical masking.");
  const out = [];
  const allowSingle = SINGLE_QUOTE_STRING_EXTS.has(ext);
  const allowBacktick = BACKTICK_EXTS.has(ext);
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    const next = src[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== `
`) {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        pushSpaces(out, src[i] ?? "");
        i += 1;
      }
      if (i + 1 < src.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" && allowSingle || ch === "`" && allowBacktick) {
      i = consumeQuoted(src, i, ch, out);
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}
function maskSourceForGuards(content, ext) {
  if (!content)
    return "";
  if (ext === PY_EXT)
    return maskPython(content);
  return maskCLike(content, ext);
}

// packages/plugins/ast-scanner/src/polyglot.ts
var TS_JS_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
function slugifyIdentifier(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function normalizeGuardAnchor(raw) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 140);
}
function hashAnchor(text) {
  let h = 2166136261;
  for (let i = 0;i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function collectMatches(content, regex, limit) {
  const out = [];
  for (const m of content.matchAll(regex)) {
    const sym = (m[1] ?? "").trim();
    if (sym && !out.includes(sym))
      out.push(sym);
    if (out.length >= limit)
      break;
  }
  return out;
}
function extractExportedSymbols(file) {
  if (!file.content)
    return [];
  if (TS_JS_EXTS.has(file.ext)) {
    const parsed = parseSync(file.rel, file.content, { lang: file.ext === ".tsx" ? "tsx" : "ts" });
    const symbols = [];
    for (const exp of parsed.module.staticExports) {
      for (const entry of exp.entries) {
        const name = entry.exportName.name;
        if (name && name !== "default" && !symbols.includes(name))
          symbols.push(name);
      }
    }
    return symbols;
  }
  if (file.ext === ".rs") {
    return collectMatches(file.content, /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm, 80);
  }
  if (file.ext === ".py") {
    return collectMatches(file.content, /^(?:async\s+def|def|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/gm, 80);
  }
  if (file.ext === ".go") {
    return collectMatches(file.content, /^(?:func\s+(?:\([^)]+\)\s+)?|type\s+)([A-Z][A-Za-z0-9_]*)\b/gm, 80);
  }
  if (file.ext === ".cs") {
    return collectMatches(file.content, /\bpublic\s+(?:(?:static|sealed|abstract|partial|readonly|virtual|override|async)\s+)*(?:class|interface|record|struct|enum|void|[A-Za-z0-9_<>?]+)\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*(?:\(|\{|where|:)/g, 80);
  }
  return [];
}
function extractTestCases(file) {
  if (!file.content)
    return [];
  const cases = [];
  const push = (name, index) => {
    const clean = name.trim();
    if (!clean)
      return;
    const line = file.content.slice(0, index).split(`
`).length;
    cases.push({ name: clean, line });
  };
  if (TS_JS_EXTS.has(file.ext)) {
    for (const m of file.content.matchAll(/\b(?:test|it|describe)\s*\(\s*(["'`])([^"'`\n]{3,140})\1/g)) {
      push(m[2] ?? "", m.index ?? 0);
    }
    return cases;
  }
  if (file.ext === ".rs") {
    for (const m of file.content.matchAll(/#\[(?:tokio::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)) {
      push(m[1] ?? "", m.index ?? 0);
    }
    return cases;
  }
  if (file.ext === ".py") {
    for (const m of file.content.matchAll(/^(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm)) {
      push(m[1] ?? "", m.index ?? 0);
    }
    return cases;
  }
  if (file.ext === ".go") {
    for (const m of file.content.matchAll(/^func\s+(Test[A-Za-z0-9_]+)\s*\(/gm)) {
      push(m[1] ?? "", m.index ?? 0);
    }
    return cases;
  }
  if (file.ext === ".cs") {
    for (const m of file.content.matchAll(/\[(?:Fact|Theory|Test|TestMethod)\b[^\]]*\][\s\S]{0,180}?\b([A-Z][A-Za-z0-9_]+)\s*\(/g)) {
      push(m[1] ?? "", m.index ?? 0);
    }
  }
  return cases;
}
function makeInv(input) {
  const anchor = normalizeGuardAnchor(input.guardAnchor);
  return {
    id: `inv:ast:${input.suffix}:${slugifyIdentifier(input.file.rel)}:${hashAnchor(anchor)}`,
    featureId: input.featureId,
    kind: input.kind,
    statement: input.statement,
    file: input.file.rel,
    line: input.line,
    confidence: input.confidence,
    source: "ast",
    guardAnchor: anchor,
    status: "active"
  };
}
function windowSlice(lines, start, span) {
  return lines.slice(start, start + span).map((l) => l.trim()).join(" ");
}
function matchTsJsGuard(file, featureId, scan, i) {
  if (i < 0 || i >= scan.lines.length)
    throw new Error("Line index out of bounds.");
  const masked = (scan.lines[i] ?? "").trim();
  const raw = (scan.rawLines[i] ?? "").trim();
  const next3 = windowSlice(scan.lines, i, 3);
  const ln = i + 1;
  if (/\bCommand\.make\s*\(/.test(masked) && /\bCommand\.make\s*\(\s*["']([^"']+)["']/.test(raw)) {
    const cmd = /\bCommand\.make\s*\(\s*["']([^"']+)["']/.exec(raw)?.[1] ?? "command";
    return makeInv({ file, featureId, kind: "cli-contract", line: ln, confidence: 0.9, statement: `CLI subcommand '${cmd}' contract registered at ${file.rel}:${ln}`, guardAnchor: raw, suffix: `cli-${slugifyIdentifier(cmd)}` });
  }
  if (/\bif\s*\([^)]{2,140}\)/.test(masked) && /\bthrow\s+(?:new\s+(?:[A-Z]\w*)?(?:Error|Exception)|[A-Z]\w*(?:Error|Exception)\.[A-Za-z_]\w*)\s*\(/.test(next3)) {
    return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.88, statement: `Precondition fail-closed guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "precondition" });
  }
  if (/\bif\s*\([^)]{2,140}\)/.test(masked) && /\breturn\b[\s\S]{0,160}\b(?:[a-z]\w*(?:Rejection|Denied|Forbidden|Unauthorized|Invalid)\s*\(|new\s+Response\s*\([^)]*40[0134]\b)/.test(windowSlice(scan.lines, i, 5))) {
    return makeInv({ file, featureId, kind: "fail-closed-return-guard", line: ln, confidence: 0.86, statement: `Fail-closed rejection guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "reject" });
  }
  if (/\b(?:assert\.ok|invariant)\s*\(/.test(masked)) {
    return makeInv({ file, featureId, kind: "runtime-invariant", line: ln, confidence: 0.88, statement: `Runtime invariant check: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "invariant" });
  }
  return null;
}
function matchPolyglotLine(file, featureId, scan, i) {
  const { lines, rawLines } = scan;
  if (i < 0 || i >= lines.length)
    throw new Error("Line index out of bounds.");
  const text = (lines[i] ?? "").trim();
  const raw = (rawLines[i] ?? "").trim();
  const next3 = windowSlice(lines, i, 3);
  const ln = i + 1;
  if (/\bRAISE\s*\(\s*ABORT\b/i.test(text)) {
    return makeInv({ file, featureId, kind: "db-trigger-guard", line: ln, confidence: 0.95, statement: `SQLite trigger aborts disallowed mutation at ${file.rel}:${ln}`, guardAnchor: raw, suffix: "sql-trigger" });
  }
  if (TS_JS_EXTS.has(file.ext))
    return matchTsJsGuard(file, featureId, scan, i);
  if (file.ext === ".rs") {
    if (/\b(?:assert!|assert_eq!|assert_ne!|debug_assert!|ensure!|bail!)\s*\(/.test(text)) {
      return makeInv({ file, featureId, kind: "rust-assert-guard", line: ln, confidence: 0.9, statement: `Rust invariant assertion: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "rs-assert" });
    }
    if (/^if\s+[^{]{2,120}\{/.test(text) && /\breturn\s+Err\s*\(/.test(windowSlice(lines, i, 5))) {
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.84, statement: `Rust error guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "rs-err" });
    }
    return null;
  }
  if (file.ext === ".py") {
    if (/^(?:if|elif)\s+[^:]{2,120}:/.test(text) && /\braise\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(windowSlice(lines, i, 9))) {
      const anchor = raw.replace(/\s*#.*$/, "").trim();
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.88, statement: `Python precondition guard: ${anchor.slice(0, 110)}`, guardAnchor: anchor, suffix: "py-raise" });
    }
    if (/^except\s+\(?[A-Za-z0-9_.,\s]+\)?(?:\s+as\s+\w+)?\s*:/.test(text) && /\braise\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(windowSlice(lines, i, 4))) {
      const anchor = raw.replace(/\s*#.*$/, "").trim();
      return makeInv({ file, featureId, kind: "py-except-guard", line: ln, confidence: 0.87, statement: `Python exception translation guard: ${anchor.slice(0, 110)}`, guardAnchor: anchor, suffix: "py-except" });
    }
    if (/^assert\s+[^#]{3,120}/.test(text)) {
      return makeInv({ file, featureId, kind: "python-assert-guard", line: ln, confidence: 0.85, statement: `Python invariant assertion: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "py-assert" });
    }
    return null;
  }
  if (file.ext === ".go") {
    const next5 = windowSlice(lines, i, 5);
    if (/^if\s+[^{]{2,120}\{/.test(text) && /\b(?:fmt\.Errorf|errors\.New|http\.Error)\s*\(/.test(next5)) {
      const isHttp = /\bhttp\.Error\s*\(/.test(next5);
      const kind = isHttp ? "go-http-guard" : "go-error-guard";
      return makeInv({ file, featureId, kind, line: ln, confidence: isHttp ? 0.94 : 0.84, statement: `Go guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "go-err" });
    }
    return null;
  }
  if (file.ext === ".cs") {
    if (/\b(?:ArgumentNullException|ArgumentOutOfRangeException|ArgumentException|ObjectDisposedException)\.ThrowIf\w*\s*\(|\bGuard\.(?:NotNull|Range|NotNullOrEmpty)\s*\(/.test(text)) {
      return makeInv({ file, featureId, kind: "csharp-guard-clause", line: ln, confidence: 0.92, statement: `C# guard clause: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "cs-guard" });
    }
    if (/^if\s*\([^)]{2,140}\)/.test(text) && /\bthrow\s+new\s+[A-Z]\w*Exception\s*\(/.test(next3)) {
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.85, statement: `C# precondition guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "cs-throw" });
    }
  }
  return null;
}
function scanFileInvariants(file, featureId) {
  if (!featureId)
    throw new Error("featureId is required for invariant scanning.");
  if (file.isTest)
    return [];
  const found = [];
  const seenIds = new Set;
  const rawLines = file.content.split(`
`);
  const lines = maskSourceForGuards(file.content, file.ext).split(`
`);
  const scan = { lines, rawLines };
  const isRust = file.ext === ".rs";
  for (let i = 0;i < lines.length; i += 1) {
    const text = (lines[i] ?? "").trim();
    if (!text)
      continue;
    if (isRust && text.startsWith("#[cfg(test)]"))
      break;
    const inv = matchPolyglotLine(file, featureId, scan, i);
    if (inv && !seenIds.has(inv.id)) {
      seenIds.add(inv.id);
      found.push(inv);
    }
  }
  if (found.length <= 24)
    return found;
  return found.toSorted((a, b) => {
    const diff = b.confidence - a.confidence;
    return diff !== 0 ? diff : a.line - b.line;
  }).slice(0, 24);
}

// packages/plugins/ast-scanner/src/root-tests.ts
import path4 from "path";
function stemOf(relPath) {
  return path4.posix.basename(relPath, path4.posix.extname(relPath)).replace(/^_+/, "").replace(/\.(?:test|spec)$/i, "").replace(/(?:_test|tests?)$/i, "").replace(/^test_/, "").toLowerCase();
}
function addToBucket(map, key, item) {
  if (!key)
    return;
  const list = map.get(key);
  if (list)
    list.push(item);
  else
    map.set(key, [item]);
}
function extractTokens(text) {
  const tokens = new Set;
  for (const m of text.matchAll(/[a-z][a-z0-9]{3,40}/g)) {
    tokens.add(m[0]);
    if (tokens.size >= 500)
      break;
  }
  return tokens;
}
function buildTestIndex(allTestFiles) {
  if (!Array.isArray(allTestFiles))
    throw new Error("allTestFiles must be an array.");
  const all = [];
  const byDir = new Map;
  const byStem = new Map;
  const byToken = new Map;
  for (const file of allTestFiles) {
    const dir = path4.posix.dirname(file.rel);
    const stem = stemOf(file.rel);
    const relLower = file.rel.toLowerCase();
    const contentLower = file.content.toLowerCase();
    const item = { file, dir, stem, relLower, contentLower, cases: extractTestCases(file) };
    all.push(item);
    addToBucket(byDir, dir, item);
    addToBucket(byStem, stem, item);
    for (const part of stem.split(/[^a-z0-9]+/).filter((p) => p.length >= 4))
      addToBucket(byStem, part, item);
    for (const tok of extractTokens(`${relLower} ${contentLower.slice(0, 16000)}`))
      addToBucket(byToken, tok, item);
  }
  return { all, byDir, byStem, byToken };
}
function invariantKeywords(statement) {
  const stop = new Set(["precondition", "guard", "fail", "closed", "error", "return", "throw", "raise", "assert", "string", "typeof", "value", "const", "invalid", "python", "rust", "csharp", "clause", "invariant", "assertion"]);
  return statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((tok) => tok.length >= 4 && !stop.has(tok)).slice(0, 6);
}
function findEnclosingSymbol(file, line) {
  const lines = file.content.split(`
`);
  const start = Math.max(0, Math.min(lines.length - 1, line - 1));
  const floor = Math.max(0, start - 35);
  for (let i = start;i >= floor; i -= 1) {
    const raw = (lines[i] ?? "").trim();
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw) ?? /^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/.exec(raw) ?? /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw) ?? /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw) ?? /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(raw) ?? /\b(?:public|internal|private|protected)\s+(?:(?:static|sealed|abstract|virtual|override|async)\s+)*[A-Za-z0-9_<>?]+\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\(/.exec(raw);
    if (m?.[1] && m[1].length >= 4)
      return m[1];
  }
  return null;
}
function scoreTestForRoot(ctx, tf) {
  if (!tf.file.rel)
    throw new Error("Test file path is required.");
  let score = 0;
  if (tf.dir === ctx.prodDir) {
    score += 8;
    if (ctx.prodStem && (tf.stem === ctx.prodStem || tf.stem.startsWith(`${ctx.prodStem}_`) || tf.stem.startsWith(ctx.prodStem))) {
      score += 12;
    }
  } else if (ctx.prodStem && ctx.prodStem !== "index" && ctx.prodStem !== "mod" && ctx.prodStem !== "lib") {
    if (tf.stem === ctx.prodStem || tf.stem.includes(ctx.prodStem))
      score += 10;
  }
  if (ctx.parentName && ctx.parentName.length >= 4 && ctx.parentName !== "src" && tf.relLower.includes(`/${ctx.parentName}/`)) {
    score += 8;
  } else if (ctx.parentName && ctx.parentName.length >= 3 && ctx.parentName !== "src" && tf.relLower.includes(ctx.parentName)) {
    score += 4;
  }
  if (ctx.enclosingSymbol && tf.contentLower.includes(ctx.enclosingSymbol.toLowerCase())) {
    score += 18;
  }
  let symHits = 0;
  for (const sym of ctx.symbols) {
    if (sym.length >= 4 && tf.contentLower.includes(sym.toLowerCase())) {
      symHits += 1;
      if (symHits >= 2)
        break;
    }
  }
  score += symHits * 5;
  let kwHits = 0;
  for (const kw of ctx.keywords) {
    if (tf.contentLower.includes(kw) || tf.relLower.includes(kw)) {
      kwHits += 1;
      if (kwHits >= 2)
        break;
    }
  }
  score += kwHits * 5;
  return score;
}
function gatherCandidates(ctx, index) {
  const seen = new Set;
  const out = [];
  const addList = (list) => {
    if (!list)
      return;
    for (const item of list) {
      if (seen.has(item.file.rel))
        continue;
      seen.add(item.file.rel);
      out.push(item);
      if (out.length >= 60)
        return;
    }
  };
  addList(index.byDir.get(ctx.prodDir));
  addList(index.byStem.get(ctx.prodStem));
  for (const part of ctx.parentName.split(/[^a-z0-9]+/).filter((p) => p.length >= 4)) {
    addList(index.byToken.get(part));
  }
  if (ctx.enclosingSymbol) {
    const cleanSym = ctx.enclosingSymbol.toLowerCase().replace(/^_+/, "");
    addList(index.byToken.get(cleanSym));
    for (const part of cleanSym.split(/[^a-z0-9]+/).filter((p) => p.length >= 4))
      addList(index.byToken.get(part));
  }
  for (const sym of ctx.symbols.slice(0, 6)) {
    const cleanSym = sym.toLowerCase().replace(/^_+/, "");
    addList(index.byToken.get(cleanSym));
    for (const part of cleanSym.split(/[^a-z0-9]+/).filter((p) => p.length >= 4))
      addList(index.byToken.get(part));
  }
  for (const kw of ctx.keywords)
    addList(index.byToken.get(kw));
  if (out.length === 0 && index.all.length <= 20)
    addList(index.all);
  return out;
}
function resolveRootTestForFile(query) {
  if (!query.prodFile.rel)
    throw new Error("prodFile.rel is required.");
  if (query.prodFile.ext === ".rs") {
    const inlineCases = extractTestCases(query.prodFile);
    if (inlineCases.length > 0) {
      return {
        file: query.prodFile,
        dir: path4.posix.dirname(query.prodFile.rel),
        stem: stemOf(query.prodFile.rel),
        relLower: query.prodFile.rel.toLowerCase(),
        contentLower: "",
        cases: inlineCases
      };
    }
  }
  const prodDir = path4.posix.dirname(query.prodFile.rel);
  const ctx = {
    prodDir,
    prodStem: stemOf(query.prodFile.rel),
    parentName: path4.posix.basename(prodDir).toLowerCase(),
    symbols: query.symbols,
    enclosingSymbol: findEnclosingSymbol(query.prodFile, query.invariantLine),
    keywords: invariantKeywords(query.invariantText)
  };
  const candidates = gatherCandidates(ctx, query.testIndex);
  let best;
  let bestScore = 0;
  for (const tf of candidates) {
    const score = scoreTestForRoot(ctx, tf);
    if (score > bestScore || score === bestScore && score > 0 && best && tf.file.rel.localeCompare(best.file.rel) < 0) {
      bestScore = score;
      best = tf;
    }
  }
  return bestScore >= 6 ? best : undefined;
}

// packages/plugins/ast-scanner/src/index.ts
var NON_PROD_PREFIX = /^(?:\.github|examples|samples|snippets|templates|fixtures|testdata|__fixtures__|bench|benchmarks|benchsuite|perf-measures|fuzz|docs|docs_src|tools|scripts|build|eng|pkg|ci|caddytest)\//i;
var NON_PROD_SEGMENT = /(?:^|\/)(?:snippets|samples|benchmarks|__fixtures__|fixtures|testdata|examples|templates|caught|snapshots)\//i;
var GENERATED_FILE_RE = /\.(?:d\.ts|pb\.go|g\.cs|generated\.[a-z]+)$|(?:^|\/)(?:cake\.cs|build\.rs|setup\.py|conftest\.py)$/i;
var SRC_SUBFEATURE_CONTAINERS = new Set(["middleware", "helper", "router", "adapter", "plugins", "features", "services", "handlers"]);
function areaFromPath(rel, ext) {
  const parts = rel.split("/");
  if (parts[0] === "packages" && parts[1] === "plugins" && parts[2])
    return `plugin:${parts[2]}`;
  if (parts[0] === "packages" && parts[1])
    return parts[1];
  if (parts[0] === "crates" && parts[1])
    return `crate:${parts[1]}`;
  if (parts[0] === "modules" && parts[1])
    return `module:${parts[1]}`;
  if ((parts[0] === "cmd" || parts[0] === "internal" || parts[0] === "caddyconfig") && parts.length >= 3 && parts[1]) {
    return `${parts[0]}:${parts[1]}`;
  }
  if (ext === ".py" && parts[0] === "src" && parts.length >= 5 && parts[1] && parts[2] === parts[1] && parts[3]) {
    return `${parts[1]}:${parts[3].replace(/^_+/, "") || "core"}`;
  }
  if (ext === ".py" && parts.length >= 4 && parts[0] && parts[1] && parts[0].startsWith(parts[1]) && parts[2]) {
    return `${parts[1]}:${parts[2].replace(/^_+/, "") || "core"}`;
  }
  if (parts[0] === "src" && parts.length >= 4 && parts[1] && parts[2] && SRC_SUBFEATURE_CONTAINERS.has(parts[1])) {
    return `${parts[1]}:${parts[2]}`;
  }
  if (parts[0] === "src" && parts.length >= 3 && parts[1])
    return parts[1];
  if (parts[0] === "tests" && parts.length >= 3 && parts[1])
    return parts[1];
  if (ext === ".py" && parts.length === 2 && parts[0] && parts[1]) {
    const stem = parts[1].replace(/\.py$/i, "").replace(/^_+/, "");
    if (stem && !["init", "version", "compat", "types", "main"].includes(stem))
      return `${parts[0]}:${stem}`;
    return `${parts[0]}:core`;
  }
  if (ext === ".py" && parts.length >= 3 && parts[0] && parts[1]) {
    return `${parts[0]}:${parts[1].replace(/^_+/, "") || "core"}`;
  }
  return path5.posix.dirname(rel) === "." ? "root" : parts[0] ?? "core";
}
function matchTestsForBucket(area, bucket, testIndex) {
  if (!area)
    throw new Error("area is required.");
  const matched = [];
  const seen = new Set;
  for (const tf of bucket.testFiles) {
    seen.add(tf.rel);
    matched.push({ file: tf, cases: extractTestCases(tf) });
  }
  for (const pf of bucket.prodFiles) {
    if (pf.ext !== ".rs")
      continue;
    const inlineCases = extractTestCases(pf);
    if (inlineCases.length > 0 && !seen.has(pf.rel)) {
      seen.add(pf.rel);
      matched.push({ file: pf, cases: inlineCases });
    }
  }
  for (const sym of bucket.symbols) {
    if (sym.length < 5)
      continue;
    for (const hit of testIndex.byStem.get(sym.toLowerCase()) ?? []) {
      if (seen.has(hit.file.rel))
        continue;
      seen.add(hit.file.rel);
      matched.push({ file: hit.file, cases: hit.cases });
    }
  }
  if (matched.length > 0)
    return matched.slice(0, 8);
  const cleanArea = area.replace(/^(?:plugin|crate|module|cmd|internal|caddyconfig):/, "").toLowerCase();
  const tailToken = cleanArea.split(":").pop() ?? cleanArea;
  const areaTokens = tailToken.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const symbolHints = bucket.symbols.filter((s) => s.length >= 4).slice(0, 6).map((s) => s.toLowerCase());
  const candidateSet = new Set;
  for (const key of [tailToken, slugifyIdentifier(tailToken), ...areaTokens, ...symbolHints]) {
    for (const hit of testIndex.byStem.get(key) ?? [])
      candidateSet.add(hit);
    for (const hit of testIndex.byToken.get(key) ?? [])
      candidateSet.add(hit);
  }
  const pool = candidateSet.size > 0 ? Array.from(candidateSet) : testIndex.all.slice(0, 120);
  for (const item of pool) {
    if (seen.has(item.file.rel))
      continue;
    const hitArea = item.relLower.includes(tailToken) || item.contentLower.includes(tailToken) || item.relLower.includes(slugifyIdentifier(tailToken)) || areaTokens.length > 0 && areaTokens.every((tok) => item.relLower.includes(tok) || item.contentLower.includes(tok));
    const hitSymbol = symbolHints.some((sym) => item.contentLower.includes(sym));
    if (hitArea || hitSymbol) {
      seen.add(item.file.rel);
      matched.push({ file: item.file, cases: item.cases });
      if (matched.length >= 5)
        break;
    }
  }
  return matched;
}
function buildFeatureRecords(area, bucket, testIndex) {
  if (bucket.prodFiles.length === 0)
    return { features: [], tests: [], invariants: [] };
  const featureId = `feat.${slugifyIdentifier(area)}`;
  const sampleSymbols = bucket.symbols.slice(0, 6).join(", ");
  const feature = {
    id: featureId,
    area,
    name: `${area} capability`,
    summary: `Extracted from ${bucket.prodFiles.length} source file(s)${sampleSymbols ? ` exporting ${sampleSymbols}` : ""}.`,
    acceptanceCriteria: `Exports and behaviors in ${area} remain covered by linked tests and preserve extracted invariants.`,
    status: "active",
    source: "ast"
  };
  const testMap = new Map;
  const addTestLink = (tf, cases) => {
    const pattern = cases[0]?.name ?? path5.posix.basename(tf.rel);
    const rung = tf.rel.includes(".mbt.") ? "R3" : "R2";
    testMap.set(`${tf.rel}|${pattern}`, { featureId, testPath: tf.rel, testPattern: pattern, rung });
  };
  for (const hit of matchTestsForBucket(area, bucket, testIndex))
    addTestLink(hit.file, hit.cases);
  const invariants = [];
  for (const pf of bucket.prodFiles) {
    const fileInvs = scanFileInvariants(pf, featureId);
    const fileSyms = bucket.fileSymbols.get(pf.rel) ?? [];
    for (const inv of fileInvs) {
      const rootHit = resolveRootTestForFile({
        prodFile: pf,
        symbols: fileSyms,
        invariantText: inv.statement,
        invariantLine: inv.line,
        testIndex
      });
      if (rootHit)
        addTestLink(rootHit.file, rootHit.cases);
      invariants.push(rootHit ? { ...inv, rootTestPath: rootHit.file.rel } : inv);
      if (invariants.length >= 250)
        break;
    }
    if (invariants.length >= 250)
      break;
  }
  return { features: [feature], tests: [...testMap.values()], invariants };
}
function extractFromRepo(ctx) {
  if (!ctx.repoRoot)
    throw new Error("ScanContext.repoRoot is required.");
  const byArea = new Map;
  for (const file of ctx.files) {
    if (file.rel === "features/registry.sql")
      continue;
    if (!file.isTest && (NON_PROD_PREFIX.test(file.rel) || NON_PROD_SEGMENT.test(file.rel) || GENERATED_FILE_RE.test(file.rel)))
      continue;
    const area = areaFromPath(file.rel, file.ext);
    const bucket = byArea.get(area) ?? { prodFiles: [], testFiles: [], symbols: [], fileSymbols: new Map };
    if (file.isTest) {
      bucket.testFiles.push(file);
    } else {
      bucket.prodFiles.push(file);
      const syms = extractExportedSymbols(file);
      bucket.fileSymbols.set(file.rel, syms);
      for (const sym of syms) {
        if (!bucket.symbols.includes(sym))
          bucket.symbols.push(sym);
      }
    }
    byArea.set(area, bucket);
  }
  const features = [];
  const tests = [];
  const invariants = [];
  const testIndex = buildTestIndex(ctx.files.filter((f) => f.isTest));
  for (const [area, bucket] of [...byArea.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const out = buildFeatureRecords(area, bucket, testIndex);
    features.push(...out.features);
    tests.push(...out.tests);
    invariants.push(...out.invariants);
  }
  return { features, tests, invariants };
}
var src_default2 = Plugin.define({
  id: "featlock.ast-scanner",
  async setup(ctx) {
    await ctx.extractor.transform((ed) => {
      ed.add({
        id: "featlock.ast-scanner.extractor",
        label: "Polyglot AST Feature, Test & Invariant Extractor",
        extract: extractFromRepo
      });
    });
  }
});

// packages/plugins/config/src/index.ts
var src_default3 = Plugin.define({
  id: "featlock.config",
  async setup(ctx) {
    await ctx.reporter.transform((ed) => {
      ed.add({
        id: "json",
        format: (payload) => JSON.stringify(payload, null, 2)
      });
    });
  }
});

// packages/plugins/harnesses/src/index.ts
import fs4 from "fs";
import path6 from "path";
var HOOK_SCRIPT_CONTENT = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const localBin = path.resolve("node_modules/.bin/featlock");
const cmd = fs.existsSync(localBin) ? localBin : "bunx";
const args = fs.existsSync(localBin) ? ["check", "."] : ["featlock", "check", "."];
const res = spawnSync(cmd, args, { encoding: "utf8" });
if (res.error || res.status !== 0) {
  process.stderr.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  if (res.error) process.stderr.write(String(res.error.message || res.error) + "\\n");
  process.stderr.write("\\nFEATLOCK GUARD: Feature/invariant integrity check failed. Do NOT silently delete features or invariants.\\n");
  process.exit(2);
}
`;
var AGENT_RULE_BLOCK = `<!-- featlock:start -->
## FeatLock Feature & Invariant Guard Rules
- Before implementing any new capability, run \`featlock query <topic>\` and \`featlock check-dup "<summary>"\` so you do not duplicate an existing feature.
- On every change that adds or improves product behavior, automatically record it with \`featlock record-new\` or \`featlock record-improvement\` in \`features/registry.sql\`.
- NEVER delete an active feature, unlink its tests, or delete an active invariant without explicit human confirmation, an ADR reference, and \`ALLOW_FEATURE_REMOVAL=1\`.
<!-- featlock:end -->
`;
function readJsonObject(filePath) {
  if (!fs4.existsSync(filePath))
    return {};
  try {
    const parsed = JSON.parse(fs4.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function entryHasMarker(entry, marker) {
  if (!entry || typeof entry !== "object")
    return false;
  return JSON.stringify(entry).includes(marker);
}
function wireJsonHookConfig(repoRoot, binding, relScript) {
  if (!repoRoot || !relScript)
    throw new Error("repoRoot and relScript are required.");
  const absConfig = path6.join(repoRoot, binding.configRel);
  const root = readJsonObject(absConfig);
  if (binding.format === "flat" && root.version === undefined)
    root.version = 1;
  const hooksObj = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? { ...root.hooks } : {};
  const list = Array.isArray(hooksObj[binding.eventKey]) ? [...hooksObj[binding.eventKey]] : [];
  if (list.some((item) => entryHasMarker(item, relScript)))
    return false;
  const command = `node ${relScript}`;
  const entry = binding.format === "nested" ? { hooks: [{ type: "command", command }] } : { command };
  list.push(entry);
  hooksObj[binding.eventKey] = list;
  root.hooks = hooksObj;
  fs4.mkdirSync(path6.dirname(absConfig), { recursive: true });
  fs4.writeFileSync(absConfig, `${JSON.stringify(root, null, 2)}
`, "utf8");
  return true;
}
function unwireJsonHookConfig(repoRoot, binding, relScript) {
  const absConfig = path6.join(repoRoot, binding.configRel);
  if (!fs4.existsSync(absConfig))
    return false;
  const root = readJsonObject(absConfig);
  const hooksObj = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? { ...root.hooks } : null;
  if (!hooksObj || !Array.isArray(hooksObj[binding.eventKey]))
    return false;
  const before = hooksObj[binding.eventKey];
  const after = before.filter((item) => !entryHasMarker(item, relScript));
  if (after.length === before.length)
    return false;
  hooksObj[binding.eventKey] = after;
  root.hooks = hooksObj;
  fs4.writeFileSync(absConfig, `${JSON.stringify(root, null, 2)}
`, "utf8");
  return true;
}
function isJsonHookWired(repoRoot, binding, relScript) {
  const absConfig = path6.join(repoRoot, binding.configRel);
  if (!fs4.existsSync(absConfig))
    return false;
  const root = readJsonObject(absConfig);
  const hooksObj = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks : null;
  if (!hooksObj || !Array.isArray(hooksObj[binding.eventKey]))
    return false;
  return hooksObj[binding.eventKey].some((item) => entryHasMarker(item, relScript));
}
function ensureAgentRule(filePath) {
  fs4.mkdirSync(path6.dirname(filePath), { recursive: true });
  const existing = fs4.existsSync(filePath) ? fs4.readFileSync(filePath, "utf8") : "";
  if (existing.includes("<!-- featlock:start -->"))
    return false;
  const next = existing.trim().length > 0 ? `${existing.trimEnd()}

${AGENT_RULE_BLOCK}` : AGENT_RULE_BLOCK;
  fs4.writeFileSync(filePath, next, "utf8");
  return true;
}
function removeAgentRule(filePath) {
  if (!fs4.existsSync(filePath))
    return false;
  const existing = fs4.readFileSync(filePath, "utf8");
  if (!existing.includes("<!-- featlock:start -->"))
    return false;
  const cleaned = existing.replace(/\n*<!-- featlock:start -->[\s\S]*?<!-- featlock:end -->\n*/g, `
`).trim();
  fs4.writeFileSync(filePath, cleaned ? `${cleaned}
` : "", "utf8");
  return true;
}
function makeFileHookHarness(spec) {
  if (!spec.id || !spec.relScript)
    throw new Error("Harness id and relScript are required.");
  const { id, label, relScript, docRel, binding } = spec;
  return {
    id,
    label,
    install: (repoRoot) => {
      const touched = [];
      const absHook = path6.join(repoRoot, relScript);
      fs4.mkdirSync(path6.dirname(absHook), { recursive: true });
      fs4.writeFileSync(absHook, HOOK_SCRIPT_CONTENT, { encoding: "utf8", mode: 493 });
      touched.push(relScript);
      if (binding && wireJsonHookConfig(repoRoot, binding, relScript))
        touched.push(binding.configRel);
      if (ensureAgentRule(path6.join(repoRoot, docRel)))
        touched.push(docRel);
      return touched;
    },
    uninstall: (repoRoot) => {
      const touched = [];
      const absHook = path6.join(repoRoot, relScript);
      if (fs4.existsSync(absHook)) {
        fs4.rmSync(absHook, { force: true });
        touched.push(relScript);
      }
      if (binding && unwireJsonHookConfig(repoRoot, binding, relScript))
        touched.push(binding.configRel);
      if (removeAgentRule(path6.join(repoRoot, docRel)))
        touched.push(docRel);
      return touched;
    },
    status: async (repoRoot) => {
      const scriptExists = fs4.existsSync(path6.join(repoRoot, relScript));
      const wired = binding ? isJsonHookWired(repoRoot, binding, relScript) : true;
      const installed = scriptExists && wired;
      const detail = installed ? binding ? `active (${relScript} + ${binding.configRel})` : `active (${relScript})` : scriptExists ? `unwired (${relScript} missing registration in ${binding?.configRel ?? "config"})` : `not installed (${relScript})`;
      return { installed, detail };
    }
  };
}
var BUILTIN_HARNESS_SPECS = [
  {
    id: "claude",
    label: "Claude Code",
    relScript: ".claude/hooks/feature-guard.mjs",
    docRel: "AGENTS.md",
    binding: { configRel: ".claude/settings.local.json", eventKey: "Stop", format: "nested" }
  },
  {
    id: "codex",
    label: "Codex CLI",
    relScript: ".codex/hooks/feature-guard.mjs",
    docRel: "AGENTS.md",
    binding: { configRel: ".codex/hooks.json", eventKey: "Stop", format: "nested" }
  },
  {
    id: "cursor",
    label: "Cursor",
    relScript: ".cursor/hooks/feature-guard.mjs",
    docRel: "AGENTS.md",
    binding: { configRel: ".cursor/hooks.json", eventKey: "stop", format: "flat" }
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    relScript: ".github/hooks/feature-guard.mjs",
    docRel: ".github/copilot-instructions.md"
  }
];
var src_default4 = Plugin.define({
  id: "featlock.harnesses",
  async setup(ctx) {
    await ctx.harness.transform((ed) => {
      for (const spec of BUILTIN_HARNESS_SPECS)
        ed.add(makeFileHookHarness(spec));
    });
  }
});

// packages/plugins/invariant-passes/src/index.ts
function buildPass1Inventory(ctx, registry) {
  const registeredAreas = new Set(registry.features.map((f) => f.area));
  const prodFiles = ctx.files.filter((f) => !f.isTest).map((f) => f.rel);
  return {
    passId: "pass-1-feature-inventory",
    title: "Pass 1: Product Feature Surface Discovery",
    objective: "Identify every user-facing and system-level product capability from routes, CLI commands, exported APIs, jobs, and docs without duplicating existing features.",
    instructions: [
      `Already registered areas (${registeredAreas.size}): ${[...registeredAreas].toSorted().join(", ") || "none"}.`,
      "Run 'featlock check-dup <description>' before proposing any new feature.",
      "Ignore internal scaffolding; focus on observable behaviors users or downstream callers depend on.",
      "Record each new feature with concrete acceptance criteria and source evidence."
    ],
    targets: prodFiles.slice(0, 60),
    outputSchema: {
      features: [{ id: "feat.<area>.<slug>", area: "string", name: "string", summary: "string", acceptanceCriteria: "string" }]
    }
  };
}
function buildPass2TestBinding(ctx, registry) {
  const linkedPaths = new Set(registry.tests.map((t) => t.testPath));
  const unlinkedTests = ctx.files.filter((f) => f.isTest && !linkedPaths.has(f.rel)).map((f) => f.rel);
  const untestedFeatures = registry.features.filter((f) => f.status === "active" && !registry.tests.some((t) => t.featureId === f.id)).map((f) => f.id);
  return {
    passId: "pass-2-test-binding",
    title: "Pass 2: Feature-to-Test Traceability Binding",
    objective: "Bind every active feature to real, non-skipped tests (R0-R8) and surface untested feature gaps.",
    instructions: [
      `Active features lacking linked tests (${untestedFeatures.length}): ${untestedFeatures.join(", ") || "none"}.`,
      `Unlinked test files (${unlinkedTests.length}): inspect and bind to matching features.`,
      "Verify each linked test actually exercises the real behavior (not mocked theater)."
    ],
    targets: unlinkedTests.slice(0, 60),
    outputSchema: {
      links: [{ featureId: "string", testPath: "string", testPattern: "string", rung: "R0|R1|R2|R3|R4|R5|R6|R7|R8" }]
    }
  };
}
function buildPass3InvariantMining(ctx, registry) {
  const invCount = registry.invariants.filter((i) => i.status === "active").length;
  const criticalFiles = ctx.files.filter((f) => !f.isTest && /(?:guard|policy|state|machine|schema|auth|billing|payment|registry|pipeline|router|contract)/i.test(f.rel)).map((f) => f.rel);
  return {
    passId: "pass-3-invariant-mining",
    title: "Pass 3: Deep Invariant Mining (AST + RepoSpec + Veristack + Agent)",
    objective: "Discover hidden behavioral, state-machine, ordering, permission, and persistence invariants that must never regress.",
    instructions: [
      `Currently locked active invariants: ${invCount}.`,
      "Cross-check RepoSpec graphs/SQL rules and Veristack state-machine/law checks with deep code reading.",
      "For each invariant, state the exact condition that MUST ALWAYS HOLD, exact file:line, and the deterministic guard/test enforcing it.",
      "Prioritize fail-closed guards, monotonic state transitions, idempotency, anti-deletion locks, and wire-protocol parity."
    ],
    targets: (criticalFiles.length > 0 ? criticalFiles : ctx.files.filter((f) => !f.isTest).map((f) => f.rel)).slice(0, 60),
    outputSchema: {
      invariants: [{ id: "inv:agent:<slug>", featureId: "string", kind: "string", statement: "string", file: "string", line: 1, confidence: 0.9 }]
    }
  };
}
function buildPass4RegressionAudit(ctx, registry) {
  return {
    passId: "pass-4-regression-guard-audit",
    title: "Pass 4: Regression & Anti-Deletion Guard Verification",
    objective: "Audit all registered features and invariants for drift, duplicate capabilities, or weakened tests before shipping.",
    instructions: [
      `Audit ${registry.features.length} features, ${registry.tests.length} test links, and ${registry.invariants.length} invariants.`,
      "Run 'featlock check .' and confirm 0 error violations.",
      "Confirm agent hooks ('featlock hooks status') and CI gates are wired so future agents cannot silently drop features."
    ],
    targets: ["features/registry.sql", ...ctx.allRelPaths.filter((p) => /(?:AGENTS\.md|copilot-instructions\.md|rungs\.json)/i.test(p))],
    outputSchema: {
      status: "pass|fail",
      gaps: [{ featureId: "string", gap: "string", recommendedAction: "string" }]
    }
  };
}
var src_default5 = Plugin.define({
  id: "featlock.invariant-passes",
  async setup(ctx) {
    await ctx.agentPass.transform((ed) => {
      ed.add({ id: "pass-1-inventory", order: 1, title: "Feature Surface Inventory", buildPacket: buildPass1Inventory });
      ed.add({ id: "pass-2-tests", order: 2, title: "Feature-to-Test Binding", buildPacket: buildPass2TestBinding });
      ed.add({ id: "pass-3-invariants", order: 3, title: "Deep Invariant Mining", buildPacket: buildPass3InvariantMining });
      ed.add({ id: "pass-4-audit", order: 4, title: "Regression & Guard Audit", buildPacket: buildPass4RegressionAudit });
    });
  }
});

// packages/plugins/registry-cli/src/index.ts
function parseFlag(args, flag) {
  for (let i = 0;i < args.length; i += 1) {
    const cur = args[i] ?? "";
    if (cur === flag)
      return args[i + 1];
    if (cur.startsWith(`${flag}=`))
      return cur.slice(flag.length + 1);
  }
  return;
}
function mergeExtraction(existing, extracted) {
  if (!existing || !extracted)
    throw new Error("Existing and extracted snapshots are required.");
  const fMap = new Map(existing.features.map((f) => [f.id, f]));
  for (const f of extracted.features) {
    if (!fMap.has(f.id))
      fMap.set(f.id, f);
  }
  const tMap = new Map(existing.tests.map((t) => [`${t.featureId}|${t.testPath}|${t.testPattern}`, t]));
  for (const t of extracted.tests) {
    if (!fMap.has(t.featureId))
      continue;
    tMap.set(`${t.featureId}|${t.testPath}|${t.testPattern}`, t);
  }
  const iMap = new Map(existing.invariants.map((i) => [i.id, i]));
  for (const inv of extracted.invariants) {
    const featureId = fMap.has(inv.featureId) ? inv.featureId : extracted.features[0]?.id ?? existing.features[0]?.id;
    if (!featureId)
      continue;
    if (!iMap.has(inv.id))
      iMap.set(inv.id, { ...inv, featureId });
  }
  return {
    features: [...fMap.values()],
    tests: [...tMap.values()],
    invariants: [...iMap.values()],
    auditLog: [
      ...existing.auditLog,
      {
        featureId: "registry",
        action: "added",
        actor: "featlock-extract",
        summary: `Extracted ${extracted.features.length} feature(s), ${extracted.tests.length} test link(s), ${extracted.invariants.length} invariant(s).`
      }
    ]
  };
}
async function runExtract(ctx) {
  const extracted = await ctx.host.extract(ctx.repoRoot);
  const shouldWrite = ctx.args.includes("--write");
  if (shouldWrite) {
    const existing = await ctx.host.readRegistry(ctx.repoRoot);
    const merged = mergeExtraction(existing, extracted);
    const sqlPath = await ctx.host.writeRegistry(ctx.repoRoot, merged);
    if (ctx.asJson) {
      console.log(JSON.stringify({ sqlPath, extracted, total: { features: merged.features.length, tests: merged.tests.length, invariants: merged.invariants.length } }, null, 2));
    } else {
      console.log(`Wrote ${sqlPath}: ${merged.features.length} features, ${merged.tests.length} tests, ${merged.invariants.length} invariants.`);
    }
    return 0;
  }
  if (ctx.asJson) {
    console.log(JSON.stringify(extracted, null, 2));
  } else {
    console.log(`Extracted ${extracted.features.length} feature(s), ${extracted.tests.length} test link(s), ${extracted.invariants.length} invariant(s).`);
    for (const f of extracted.features.slice(0, 20))
      console.log(`  - [${f.source}] ${f.id}: ${f.name}`);
  }
  return 0;
}
async function runCheck(ctx) {
  const allowRemoval = ctx.args.includes("--allow-removal") ? true : undefined;
  const strictDrift = ctx.args.includes("--strict-drift") ? true : undefined;
  const res = await ctx.host.check(ctx.repoRoot, allowRemoval !== undefined || strictDrift !== undefined ? { allowRemoval, strictDrift } : undefined);
  if (ctx.asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`featlock check [${res.ok ? "PASS" : "FAIL"}]: ${res.counts.features} features, ${res.counts.tests} tests, ${res.counts.invariants} invariants | ${res.violations.length} error(s), ${res.warnings.length} warning(s)`);
    for (const v of res.violations)
      console.error(`  [ERROR] ${v.rule}: ${v.message}`);
    for (const w of res.warnings)
      console.warn(`  [WARN]  ${w.rule}: ${w.message}`);
  }
  return res.ok ? 0 : 1;
}
async function runRecordNew(ctx) {
  const id = parseFlag(ctx.args, "--id");
  const area = parseFlag(ctx.args, "--area") ?? "core";
  const name = parseFlag(ctx.args, "--name") ?? id ?? "";
  const summary = parseFlag(ctx.args, "--summary") ?? name;
  const criteria = parseFlag(ctx.args, "--criteria") ?? `Verified by linked tests for ${name}.`;
  const testPath = parseFlag(ctx.args, "--test");
  const pattern = parseFlag(ctx.args, "--pattern") ?? name;
  const rung = parseFlag(ctx.args, "--rung") ?? "R2";
  if (!id || !testPath) {
    console.error("Usage: featlock record-new --id <id> --name <name> --area <area> --summary <summary> --test <testPath>");
    return 2;
  }
  const snap = await ctx.host.recordNew({
    repoRoot: ctx.repoRoot,
    feature: { id, area, name, summary, acceptanceCriteria: criteria, status: "active", source: "manual" },
    tests: [{ featureId: id, testPath, testPattern: pattern, rung }]
  });
  console.log(ctx.asJson ? JSON.stringify({ recorded: id, totalFeatures: snap.features.length }, null, 2) : `Recorded new feature '${id}' with test '${testPath}'.`);
  return 0;
}
async function runRecordImprovement(ctx) {
  const id = parseFlag(ctx.args, "--id");
  const summary = parseFlag(ctx.args, "--summary");
  const testPath = parseFlag(ctx.args, "--test");
  const pattern = parseFlag(ctx.args, "--pattern") ?? summary ?? "improvement";
  const rung = parseFlag(ctx.args, "--rung") ?? "R2";
  if (!id || !summary) {
    console.error("Usage: featlock record-improvement --id <featureId> --summary <summary> [--test <testPath>]");
    return 2;
  }
  const extraTests = testPath ? [{ featureId: id, testPath, testPattern: pattern, rung }] : [];
  await ctx.host.recordImprovement({ repoRoot: ctx.repoRoot, featureId: id, summary, extraTests });
  console.log(ctx.asJson ? JSON.stringify({ improved: id, summary }, null, 2) : `Logged improvement to '${id}': ${summary}`);
  return 0;
}
async function runHooks(ctx) {
  const action = ctx.args[0] ?? "status";
  const harnesses = ctx.host.getHarnesses();
  if (action === "on") {
    const installed = {};
    for (const h of harnesses)
      installed[h.id] = await h.install(ctx.repoRoot);
    console.log(ctx.asJson ? JSON.stringify({ action: "on", installed }, null, 2) : `Installed FeatLock hooks for: ${harnesses.map((h) => h.id).join(", ")}`);
    return 0;
  }
  if (action === "off") {
    const removed = {};
    for (const h of harnesses)
      removed[h.id] = await h.uninstall(ctx.repoRoot);
    console.log(ctx.asJson ? JSON.stringify({ action: "off", removed }, null, 2) : `Removed FeatLock hooks for: ${harnesses.map((h) => h.id).join(", ")}`);
    return 0;
  }
  const statuses = [];
  for (const h of harnesses) {
    const st = await h.status(ctx.repoRoot);
    statuses.push({ id: h.id, ...st });
  }
  if (ctx.asJson)
    console.log(JSON.stringify({ harnesses: statuses }, null, 2));
  else
    for (const st of statuses)
      console.log(`  - ${st.id}: ${st.detail}`);
  return 0;
}
async function runSync(c) {
  const out = await c.host.sync(c.repoRoot);
  console.log(c.asJson ? JSON.stringify(out, null, 2) : `Synced ${out.dbPath} (${out.counts.features} features, ${out.counts.tests} tests, ${out.counts.invariants} invariants).`);
  return 0;
}
async function runQuery(c) {
  const term = c.args.filter((a) => !a.startsWith("-")).join(" ");
  const matches = await c.host.query(c.repoRoot, term);
  console.log(c.asJson ? JSON.stringify({ term, matches }, null, 2) : matches.map((m) => `${m.id} [${m.status}] ${m.name} \u2014 ${m.summary}`).join(`
`) || "No matching features.");
  return 0;
}
async function runCheckDup(c) {
  const desc = c.args.filter((a) => !a.startsWith("-")).join(" ");
  const dups = await c.host.checkDup(c.repoRoot, desc);
  console.log(c.asJson ? JSON.stringify({ description: desc, duplicates: dups }, null, 2) : dups.map((d) => `${d.featureId} (score=${d.score}) \u2014 ${d.name} [${d.matchedTokens.join(", ")}]`).join(`
`) || "No overlapping features detected.");
  return 0;
}
async function runAgentPass(c) {
  const packets = await c.host.buildAgentPasses(c.repoRoot);
  console.log(c.asJson ? JSON.stringify({ passes: packets }, null, 2) : packets.map((p) => `[${p.passId}] ${p.title} (${p.targets.length} targets)
  ${p.objective}`).join(`

`));
  return 0;
}
async function runPluginsList(c) {
  const list = c.host.listPlugins();
  console.log(c.asJson ? JSON.stringify({ plugins: list }, null, 2) : list.map((p) => `${p.id} [${p.state.status}] (${p.source}${p.guarded ? ", guarded" : ""})`).join(`
`));
  return 0;
}
var src_default6 = Plugin.define({
  id: "featlock.registry-cli",
  async setup(ctx) {
    await ctx.command.transform((ed) => {
      ed.add({ id: "extract", description: "Extract features, tests & invariants (AST + RepoSpec + Veristack) [--write]", run: runExtract });
      ed.add({ id: "check", description: "Verify feature coverage, invariant liveness & anti-deletion guards", run: runCheck });
      ed.add({ id: "sync", description: "Materialize .featlock/registry.sqlite from features/registry.sql", run: runSync });
      ed.add({ id: "query", description: "Search registered features by keyword", run: runQuery });
      ed.add({ id: "check-dup", description: "Check whether a proposed feature overlaps an existing registered feature", run: runCheckDup });
      ed.add({ id: "record-new", description: "Record a newly added feature + linked test in features/registry.sql", run: runRecordNew });
      ed.add({ id: "record-improvement", description: "Log an improvement to an existing feature in features/registry.sql", run: runRecordImprovement });
      ed.add({ id: "agent-pass", description: "Emit structured multi-pass AI agent investigation packets for invariant discovery", run: runAgentPass });
      ed.add({ id: "hooks", description: "Install, remove, or inspect coding agent guard hooks (on|off|status)", run: runHooks });
      ed.add({ id: "plugins", description: "List active and failed FeatLock plugins", run: runPluginsList });
    });
  }
});

// packages/plugins/repospec-bridge/src/index.ts
import { Database as Database3 } from "bun:sqlite";
import fs5 from "fs";
import path7 from "path";
function slugify(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function findRepoSpecDb(repoRoot) {
  const candidates = [
    path7.join(repoRoot, "repospec.sqlite"),
    path7.join(repoRoot, ".repospec", "repospec.sqlite"),
    path7.join(repoRoot, "out", path7.basename(repoRoot), "repospec.sqlite")
  ];
  for (const c of candidates) {
    if (fs5.existsSync(c))
      return c;
  }
  return null;
}
function findRepoSpecJson(repoRoot) {
  const candidates = [
    path7.join(repoRoot, "repospec.json"),
    path7.join(repoRoot, ".repospec", "repospec.json"),
    path7.join(repoRoot, "out", path7.basename(repoRoot), "repospec.json")
  ];
  for (const c of candidates) {
    if (fs5.existsSync(c))
      return c;
  }
  return null;
}
function extractFromSqlite(dbPath) {
  if (!dbPath)
    throw new Error("RepoSpec SQLite path is required.");
  const db = new Database3(dbPath, { readonly: true });
  const features = [];
  const tests = [];
  const invariants = [];
  try {
    const tables = new Set(db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (tables.has("module_cards")) {
      const rows = db.query("SELECT id, name, unit FROM module_cards ORDER BY id LIMIT 60").all();
      for (const r of rows) {
        features.push({
          id: `feat.rs.${slugify(r.id)}`,
          area: r.unit || "repospec",
          name: r.name || r.id,
          summary: `RepoSpec compiled module '${r.id}' in unit '${r.unit}'.`,
          acceptanceCriteria: `Module boundary and public API of '${r.id}' remain intact with zero RepoSpec invariant regressions.`,
          status: "active",
          source: "repospec"
        });
      }
    }
    if (tables.has("invariants")) {
      const rows = db.query("SELECT id, name, statement, status FROM invariants ORDER BY id LIMIT 60").all();
      for (const r of rows) {
        invariants.push({
          id: `inv:repospec:${slugify(r.id)}`,
          featureId: features[0]?.id ?? "feat.repospec-architecture",
          kind: "repospec-sql-invariant",
          statement: r.statement || r.name || r.id,
          file: path7.basename(dbPath),
          line: 1,
          confidence: 0.95,
          source: "repospec",
          guardRef: r.id,
          status: "active"
        });
      }
    }
  } finally {
    db.close();
  }
  return { features, tests, invariants };
}
function extractFromJson(jsonPath) {
  if (!jsonPath)
    throw new Error("RepoSpec JSON path is required.");
  const raw = JSON.parse(fs5.readFileSync(jsonPath, "utf8"));
  const features = [];
  const invariants = [];
  for (const ep of (raw.surfaces?.endpoints ?? []).slice(0, 40)) {
    const key = `${ep.method ?? "GET"} ${ep.path ?? "/"}`;
    features.push({
      id: `feat.http.${slugify(key)}`,
      area: "http-surface",
      name: `HTTP ${key}`,
      summary: `RepoSpec reconciled HTTP surface ${key}${ep.file ? ` (${ep.file})` : ""}.`,
      acceptanceCriteria: `Endpoint ${key} preserves contract shape and handler provenance.`,
      status: "active",
      source: "repospec"
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
      status: "active"
    });
  }
  for (const inv of (raw.invariants ?? []).slice(0, 60)) {
    invariants.push({
      id: `inv:repospec:${slugify(inv.id)}`,
      featureId: features[0]?.id ?? "feat.repospec-architecture",
      kind: "repospec-sql-invariant",
      statement: inv.statement ?? inv.name ?? inv.id,
      file: path7.basename(jsonPath),
      line: 1,
      confidence: 0.95,
      source: "repospec",
      guardRef: inv.id,
      status: "active"
    });
  }
  return { features, tests: [], invariants };
}
function extractRepoSpecArtifacts(ctx) {
  const dbPath = findRepoSpecDb(ctx.repoRoot);
  if (dbPath)
    return extractFromSqlite(dbPath);
  const jsonPath = findRepoSpecJson(ctx.repoRoot);
  if (jsonPath)
    return extractFromJson(jsonPath);
  const sqlRuleFiles = ctx.files.filter((f) => f.ext === ".sql" && /(?:^|\/)rules\//.test(f.rel));
  const invariants = [];
  for (const rf of sqlRuleFiles) {
    const idMatch = /@id:\s*([^\n]+)/.exec(rf.content);
    const stmtMatch = /@statement:\s*([^\n]+)/.exec(rf.content);
    if (!idMatch?.[1])
      continue;
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
      status: "active"
    });
  }
  return { features: [], tests: [], invariants };
}
var src_default7 = Plugin.define({
  id: "featlock.repospec-bridge",
  async setup(ctx) {
    await ctx.extractor.transform((ed) => {
      ed.add({
        id: "featlock.repospec-bridge.extractor",
        label: "RepoSpec SQLite/JSON/SQL-Rule Bridge",
        extract: extractRepoSpecArtifacts
      });
    });
    await ctx.invariantScanner.transform((ed) => {
      ed.add({
        id: "featlock.repospec-bridge.invariants",
        source: "repospec",
        scan: (scanCtx) => extractRepoSpecArtifacts(scanCtx).invariants
      });
    });
  }
});

// packages/plugins/veristack-bridge/src/index.ts
import fs6 from "fs";
import path8 from "path";
function slugify2(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function scanControlPlan(repoRoot) {
  if (!repoRoot)
    throw new Error("repoRoot is required.");
  const planPath = path8.join(repoRoot, ".verification", "control-plan.json");
  if (!fs6.existsSync(planPath))
    return [];
  const raw = JSON.parse(fs6.readFileSync(planPath, "utf8"));
  const out = [];
  for (const c of raw.controls ?? []) {
    if (!c.id)
      continue;
    out.push({
      id: `inv:veristack:cp:${slugify2(c.id)}`,
      featureId: `feat.${slugify2(c.seam ?? c.id)}`,
      kind: "veristack-control-plan",
      statement: `${c.seam ?? c.id}: prevent ${c.failureMode ?? "regression"}`,
      file: c.controlRef ?? ".verification/control-plan.json",
      line: 1,
      confidence: 0.98,
      source: "veristack",
      guardRef: c.reqId ?? c.id,
      status: "active"
    });
  }
  return out;
}
function scanLawsFiles(repoRoot) {
  const lawsDir = path8.join(repoRoot, ".verification", "laws");
  if (!fs6.existsSync(lawsDir))
    return [];
  const out = [];
  for (const entry of fs6.readdirSync(lawsDir).filter((f) => f.endsWith(".laws.json")).toSorted()) {
    const abs = path8.join(lawsDir, entry);
    const raw = JSON.parse(fs6.readFileSync(abs, "utf8"));
    for (const law of raw.laws ?? []) {
      if (!law.id)
        continue;
      out.push({
        id: `inv:veristack:law:${slugify2(law.id)}`,
        featureId: "feat.veristack-laws",
        kind: "veristack-formal-law",
        statement: law.statement ?? law.description ?? law.name ?? law.id,
        file: `.verification/laws/${entry}`,
        line: 1,
        confidence: 0.99,
        source: "veristack",
        guardRef: law.witness ?? law.id,
        status: "active"
      });
    }
  }
  return out;
}
function scanRungManifest(repoRoot) {
  const rungsPath = path8.join(repoRoot, ".verification", "rungs.json");
  if (!fs6.existsSync(rungsPath))
    return [];
  const raw = JSON.parse(fs6.readFileSync(rungsPath, "utf8"));
  const out = [];
  for (const [rungId, entry] of Object.entries(raw.rungs ?? {})) {
    if (!entry?.command)
      continue;
    out.push({
      id: `inv:veristack:rung:${slugify2(rungId)}`,
      featureId: "feat.verification-ladder",
      kind: "veristack-rung-gate",
      statement: `Verification rung ${rungId} remains wired and passing (${entry.command}).`,
      file: ".verification/rungs.json",
      line: 1,
      confidence: 0.97,
      source: "veristack",
      guardRef: rungId,
      status: "active"
    });
  }
  return out;
}
function scanVeristackArtifacts(ctx) {
  return [
    ...scanControlPlan(ctx.repoRoot),
    ...scanLawsFiles(ctx.repoRoot),
    ...scanRungManifest(ctx.repoRoot)
  ];
}
var src_default8 = Plugin.define({
  id: "featlock.veristack-bridge",
  async setup(ctx) {
    await ctx.invariantScanner.transform((ed) => {
      ed.add({
        id: "featlock.veristack-bridge.invariants",
        source: "veristack",
        scan: scanVeristackArtifacts
      });
    });
  }
});

// packages/core/src/plugin/internal.ts
var pre = [
  src_default2,
  src_default7,
  src_default8,
  src_default5,
  src_default,
  src_default4,
  src_default6
];
var post = [src_default3];
var GUARDED_PLUGIN_IDS = new Set([
  src_default.id
]);
function getBuiltinPlugins() {
  return { pre, post };
}

// packages/core/src/plugin/host.ts
function createHostDomains() {
  return {
    extractors: State.createKeyedDomain("extractor"),
    scanners: State.createKeyedDomain("invariantScanner"),
    guards: State.createKeyedDomain("guard"),
    passes: State.createKeyedDomain("agentPass"),
    harnesses: State.createKeyedDomain("harness"),
    reporters: State.createKeyedDomain("reporter"),
    commands: State.createKeyedDomain("command"),
    checkHooks: State.createKeyedDomain("checkHook"),
    slots: new Map,
    hookSeq: 0
  };
}
function matchesSelector(selector, id) {
  if (selector === "*")
    return true;
  if (selector.endsWith(".*"))
    return id.startsWith(selector.slice(0, -1));
  return selector === id;
}
async function resolveExternalPlugin(target) {
  if (!target)
    throw new Error("Plugin target path is required.");
  const abs = path9.resolve(target);
  let entryFile = abs;
  if (fs7.existsSync(abs) && fs7.statSync(abs).isDirectory()) {
    const pkgFile = path9.join(abs, "package.json");
    if (fs7.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs7.readFileSync(pkgFile, "utf8"));
      const dotExport = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
      const relEntry = typeof dotExport === "string" ? dotExport : typeof dotExport === "object" && dotExport !== null ? dotExport.import ?? dotExport.default ?? pkg.main ?? "index.ts" : pkg.main ?? "index.ts";
      entryFile = path9.resolve(abs, relEntry);
    } else {
      entryFile = path9.join(abs, "index.ts");
    }
  }
  const mod = await import(pathToFileURL(entryFile).href);
  const candidate = mod.default ?? mod.plugin;
  if (!isFeatlockPlugin(candidate)) {
    throw new Error(`Module '${target}' did not export a valid FeatLock plugin.`);
  }
  return candidate;
}
function makeDomainHandle(state, cleanups) {
  return {
    transform: async (cb) => {
      const reg = state.transform(cb);
      cleanups.push(reg.dispose);
      return reg;
    },
    reload: async () => {
      state.reload();
    }
  };
}
async function disposeSlot(slot) {
  for (const cleanup of slot.cleanups.toReversed()) {
    try {
      await cleanup();
    } catch {
      continue;
    }
  }
  slot.cleanups.length = 0;
}
async function disposeAllSlots(domains) {
  for (const slot of Array.from(domains.slots.values()).toReversed()) {
    await disposeSlot(slot);
  }
  domains.slots.clear();
}
function buildPluginContext(domains, opts, plugin, cleanups) {
  return {
    options: opts.optionsByPlugin?.[plugin.id] ?? {},
    extractor: makeDomainHandle(domains.extractors, cleanups),
    invariantScanner: makeDomainHandle(domains.scanners, cleanups),
    guard: makeDomainHandle(domains.guards, cleanups),
    agentPass: makeDomainHandle(domains.passes, cleanups),
    harness: makeDomainHandle(domains.harnesses, cleanups),
    reporter: makeDomainHandle(domains.reporters, cleanups),
    command: makeDomainHandle(domains.commands, cleanups),
    check: {
      hook: async (name, handler) => {
        const id = `${plugin.id}:hook:${++domains.hookSeq}`;
        const reg = domains.checkHooks.transform((ed) => ed.add({ id, name, handler }));
        cleanups.push(reg.dispose);
        return reg;
      }
    }
  };
}
async function mountPluginSlot(domains, opts, plugin, source) {
  if (!plugin.id)
    throw new Error("Plugin id is required.");
  const guarded = plugin.guarded === true || GUARDED_PLUGIN_IDS.has(plugin.id);
  const cleanups = [];
  const slot = { id: plugin.id, source, guarded, cleanups, lifecycle: { status: "active", group: null } };
  domains.slots.set(plugin.id, slot);
  const ctx = buildPluginContext(domains, opts, plugin, cleanups);
  try {
    const { group, result } = await State.groupAsync((failure) => {
      slot.lifecycle = {
        status: "failed",
        error: failure.cause instanceof Error ? failure.cause.message : String(failure.cause)
      };
    }, async () => await plugin.setup(ctx));
    if (typeof result === "function")
      cleanups.push(result);
    if (slot.lifecycle.status === "active")
      slot.lifecycle = { status: "active", group };
    domains.extractors.get();
    domains.scanners.get();
    domains.guards.get();
    domains.passes.get();
    domains.harnesses.get();
    domains.reporters.get();
    domains.commands.get();
    domains.checkHooks.get();
  } catch (err) {
    slot.lifecycle = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    await disposeSlot(slot);
  }
}
async function activatePlugins(domains, opts, extraPlugins, operations) {
  if (!domains)
    throw new Error("HostDomains instance is required.");
  await disposeAllSlots(domains);
  const builtins = opts.includeBuiltins === false ? { pre: [], post: [] } : getBuiltinPlugins();
  const entries = [
    ...builtins.pre.map((plugin) => ({ plugin, source: "builtin" })),
    ...extraPlugins.filter(isFeatlockPlugin).map((plugin) => ({ plugin, source: "inline" }))
  ];
  for (const op of operations) {
    if (op.type !== "add" || entries.some((e) => e.plugin.id === op.target))
      continue;
    try {
      entries.push({ plugin: await resolveExternalPlugin(op.target), source: "package" });
    } catch (err) {
      domains.slots.set(op.target, {
        id: op.target,
        source: "package",
        guarded: false,
        cleanups: [],
        lifecycle: { status: "failed", error: err instanceof Error ? err.message : String(err) }
      });
    }
  }
  entries.push(...builtins.post.map((plugin) => ({ plugin, source: "builtin" })));
  const removedSelectors = operations.filter((o) => o.type === "remove").map((o) => o.target);
  const activeEntries = entries.filter((entry) => {
    const isGuarded = entry.plugin.guarded === true || GUARDED_PLUGIN_IDS.has(entry.plugin.id);
    if (isGuarded)
      return true;
    return !removedSelectors.some((sel) => matchesSelector(sel, entry.plugin.id));
  });
  for (const entry of activeEntries)
    await mountPluginSlot(domains, opts, entry.plugin, entry.source);
}
async function runExtractWithScan(domains, scanCtx) {
  const featuresMap = new Map;
  const testsMap = new Map;
  const invariantsMap = new Map;
  for (const ext of domains.extractors.get()) {
    const out = await ext.extract(scanCtx);
    for (const f of out.features)
      featuresMap.set(f.id, f);
    for (const t of out.tests)
      testsMap.set(`${t.featureId}|${t.testPath}|${t.testPattern}`, t);
    for (const inv of out.invariants)
      invariantsMap.set(inv.id, inv);
  }
  for (const scanner of domains.scanners.get()) {
    for (const inv of await scanner.scan(scanCtx))
      invariantsMap.set(inv.id, inv);
  }
  return {
    features: Array.from(featuresMap.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    tests: Array.from(testsMap.values()),
    invariants: Array.from(invariantsMap.values()).toSorted((a, b) => a.id.localeCompare(b.id))
  };
}
async function runExtract2(domains, repoDir) {
  return await runExtractWithScan(domains, discoverRepo(repoDir));
}
async function runCheck2(domains, repoDir, checkOpts) {
  if (!repoDir)
    throw new Error("repoDir is required for featlock check.");
  const scanCtx = discoverRepo(repoDir);
  const registry = Registry.readRepo(scanCtx.repoRoot);
  const liveExtraction = await runExtractWithScan(domains, scanCtx);
  const ctx = {
    repoRoot: scanCtx.repoRoot,
    registryPath: path9.join(scanCtx.repoRoot, REGISTRY_SQL_REL),
    registry,
    previousRegistry: Registry.readHead(scanCtx.repoRoot),
    stagedFiles: listStagedFiles(scanCtx.repoRoot),
    allowRemoval: checkOpts?.allowRemoval ?? process.env.ALLOW_FEATURE_REMOVAL === "1",
    strictDrift: checkOpts?.strictDrift ?? false,
    liveExtraction,
    files: scanCtx.files
  };
  const violations = [];
  const beforeEvent = { repoRoot: scanCtx.repoRoot, violations };
  for (const h of domains.checkHooks.get().filter((x) => x.name === "beforeCheck"))
    await h.handler(beforeEvent);
  for (const guard of domains.guards.get())
    violations.push(...await guard.evaluate(ctx));
  const afterEvent = { repoRoot: scanCtx.repoRoot, violations };
  for (const h of domains.checkHooks.get().filter((x) => x.name === "afterCheck"))
    await h.handler(afterEvent);
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warn");
  return { ok: errors.length === 0, violations: errors, warnings, counts: Registry.count(registry) };
}
async function runBuildAgentPasses(domains, repoDir) {
  const scanCtx = discoverRepo(repoDir);
  const registry = Registry.readRepo(scanCtx.repoRoot);
  const packets = [];
  for (const p of domains.passes.get().toSorted((a, b) => a.order - b.order)) {
    packets.push(await p.buildPacket(scanCtx, registry));
  }
  return packets;
}
async function runCliCommand(domains, facade, argv, repoRoot) {
  const cmdName = argv[0];
  if (!cmdName || cmdName === "-h" || cmdName === "--help") {
    console.log(`featlock \u2014 Tight-core SQLite feature, test & invariant guard
`);
    for (const cmd of domains.commands.get())
      console.log(`  featlock ${cmd.id.padEnd(20)} ${cmd.description}`);
    return 0;
  }
  const found = domains.commands.get().find((c) => c.id === cmdName);
  if (!found) {
    console.error(`Unknown featlock command: ${cmdName}`);
    return 2;
  }
  const rest = argv.slice(1);
  return await found.run({ repoRoot: path9.resolve(repoRoot), args: rest, asJson: rest.includes("--json"), host: facade });
}
async function createPluginHost(opts = {}) {
  if (!opts)
    throw new Error("PluginHostOptions must be defined.");
  const domains = createHostDomains();
  const list = () => Array.from(domains.slots.values()).map((s) => ({
    id: s.id,
    source: s.source,
    state: s.lifecycle.status === "active" ? { status: "active" } : { status: "failed", error: s.lifecycle.error },
    guarded: s.guarded
  }));
  const facade = {
    listPlugins: list,
    extract: (repoDir) => runExtract2(domains, repoDir),
    check: (repoDir, checkOpts) => runCheck2(domains, repoDir, checkOpts),
    sync: async (repoDir) => {
      const out = Registry.materializeDb(path9.resolve(repoDir));
      return { sqlPath: out.sqlPath, dbPath: out.dbPath, counts: out.counts };
    },
    query: async (repoDir, term) => Registry.queryFeatures(Registry.readRepo(path9.resolve(repoDir)), term),
    checkDup: async (repoDir, description) => Registry.findDuplicates(Registry.readRepo(path9.resolve(repoDir)), description),
    recordNew: async (input) => Registry.recordNew({ ...input, repoRoot: path9.resolve(input.repoRoot) }),
    recordImprovement: async (input) => Registry.recordImprovement({ ...input, repoRoot: path9.resolve(input.repoRoot) }),
    writeRegistry: async (repoDir, snapshot) => {
      const sqlPath = Registry.writeSql(path9.resolve(repoDir), snapshot);
      Registry.materializeDb(path9.resolve(repoDir));
      return sqlPath;
    },
    readRegistry: async (repoDir) => Registry.readRepo(path9.resolve(repoDir)),
    buildAgentPasses: (repoDir) => runBuildAgentPasses(domains, repoDir),
    getHarnesses: () => domains.harnesses.get(),
    getCommands: () => domains.commands.get(),
    getReporters: () => domains.reporters.get()
  };
  await activatePlugins(domains, opts, opts.plugins ?? [], opts.operations ?? []);
  return {
    ...facade,
    list,
    activate: (extraPlugins, operations = []) => activatePlugins(domains, opts, extraPlugins, operations),
    dispose: () => disposeAllSlots(domains),
    runCli: (argv, repoRoot = process.cwd()) => runCliCommand(domains, facade, argv, repoRoot)
  };
}
var PluginHost = {
  create: createPluginHost
};
export {
  PluginHost,
  REGISTRY_DB_REL,
  REGISTRY_SQL_REL,
  Registry,
  State,
  createPluginHost,
  discoverRepo,
  listStagedFiles
};
