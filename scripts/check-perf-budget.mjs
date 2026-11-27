import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRepo, Registry } from "../packages/core/src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function buildSyntheticSnapshot(n) {
  if (!Number.isFinite(n) || n <= 0) throw new Error("Synthetic snapshot size must be positive.");
  const features = [];
  const tests = [];
  const invariants = [];
  for (let i = 0; i < n; i += 1) {
    const id = `feat.synth-${String(i).padStart(4, "0")}`;
    features.push({
      id,
      area: `area-${i % 12}`,
      name: `Synthetic feature ${i}`,
      summary: `Extracted capability ${i} for scaling check`,
      acceptanceCriteria: `Invariant ${i} remains verified.`,
      status: "active",
      source: "ast",
    });
    tests.push({ featureId: id, testPath: `tests/synth-${i % 10}.test.ts`, testPattern: `case ${i}`, rung: "R2" });
    invariants.push({
      id: `inv:synth:${i}`,
      featureId: id,
      kind: "precondition-guard",
      statement: `Precondition ${i} rejects negative input`,
      file: `src/mod-${i % 10}.ts`,
      line: i + 1,
      confidence: 0.9,
      source: "ast",
      status: "active",
    });
  }
  return { features, tests, invariants, auditLog: [] };
}

function fitLogLogSlope(samples) {
  const xs = samples.map((s) => Math.log(s.n));
  const ys = samples.map((s) => Math.log(Math.max(0.01, s.timeMs)));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den > 0 ? Number((num / den).toFixed(2)) : 0;
}

const discoverTimes = [];
for (let i = 0; i < 5; i += 1) {
  const t0 = performance.now();
  discoverRepo(repoRoot);
  discoverTimes.push(performance.now() - t0);
}
discoverTimes.sort((a, b) => a - b);
const medianDiscoverMs = Number((discoverTimes[2] ?? 0).toFixed(2));
const maxDiscoverMs = 250;
if (medianDiscoverMs > maxDiscoverMs) {
  console.error(`check-perf-budget: FAIL — discoverRepo median ${medianDiscoverMs}ms > ${maxDiscoverMs}ms.`);
  process.exit(1);
}

const scales = [40, 80, 160, 320];
for (const n of scales) {
  const snap = buildSyntheticSnapshot(n);
  Registry.loadFromSql(Registry.serializeSql(snap));
}

const samples = [];
for (const n of scales) {
  const snap = buildSyntheticSnapshot(n);
  const trials = [];
  for (let t = 0; t < 5; t += 1) {
    const t0 = performance.now();
    const sql = Registry.serializeSql(snap);
    Registry.loadFromSql(sql);
    trials.push(performance.now() - t0);
  }
  trials.sort((a, b) => a - b);
  samples.push({ n, timeMs: Number((trials[2] ?? 0.01).toFixed(2)) });
}

const exponent = fitLogLogSlope(samples);
const samplesOut = path.join(repoRoot, ".verification", "perf-samples.json");
fs.mkdirSync(path.dirname(samplesOut), { recursive: true });
fs.writeFileSync(samplesOut, `${JSON.stringify({ samples, maxTimeExponent: 1.65 }, null, 2)}\n`, "utf8");
if (exponent > 1.65) {
  console.error(`check-perf-budget: FAIL — super-linear SQLite round-trip scaling exponent=${exponent} > 1.65.`);
  process.exit(1);
}

console.log(
  `check-perf-budget: PASS (discoverRepo median=${medianDiscoverMs}ms <= ${maxDiscoverMs}ms | SQLite round-trip scaling exp=${exponent} <= 1.65).`,
);
