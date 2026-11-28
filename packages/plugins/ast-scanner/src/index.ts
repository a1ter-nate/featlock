import path from "node:path";
import {
  Plugin,
  type DiscoveredFile,
  type ExtractionOutput,
  type FeatureRecord,
  type FeatureTestLink,
  type InvariantRecord,
  type ScanContext,
} from "@featlock/plugin";
import {
  extractExportedSymbols,
  extractTestCases,
  scanFileInvariants,
  slugifyIdentifier,
} from "./polyglot.ts";
import { detectBugfixOriginFiles } from "./reiss.ts";
import { buildTestIndex, resolveRootTestForFile, type TestIndex } from "./root-tests.ts";

const NON_PROD_PREFIX =
  /^(?:\.github|examples|samples|snippets|templates|fixtures|testdata|__fixtures__|bench|benchmarks|benchsuite|perf-measures|fuzz|docs|docs_src|tools|scripts|build|eng|pkg|ci|caddytest)\//i;
const NON_PROD_SEGMENT = /(?:^|\/)(?:snippets|samples|benchmarks|__fixtures__|fixtures|testdata|examples|templates|caught|snapshots)\//i;
const GENERATED_FILE_RE = /\.(?:d\.ts|pb\.go|g\.cs|generated\.[a-z]+)$|(?:^|\/)(?:cake\.cs|build\.rs|setup\.py|conftest\.py)$/i;
const SRC_SUBFEATURE_CONTAINERS = new Set(["middleware", "helper", "router", "adapter", "plugins", "features", "services", "handlers"]);

function areaFromPath(rel: string, ext: string): string {
  const parts = rel.split("/");
  if (parts[0] === "packages" && parts[1] === "plugins" && parts[2]) return `plugin:${parts[2]}`;
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "crates" && parts[1]) return `crate:${parts[1]}`;
  if (parts[0] === "modules" && parts[1]) return `module:${parts[1]}`;
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
  if (parts[0] === "src" && parts.length >= 3 && parts[1]) return parts[1];
  if (parts[0] === "tests" && parts.length >= 3 && parts[1]) return parts[1];
  if (ext === ".py" && parts.length === 2 && parts[0] && parts[1]) {
    const stem = parts[1].replace(/\.py$/i, "").replace(/^_+/, "");
    if (stem && !["init", "version", "compat", "types", "main"].includes(stem)) return `${parts[0]}:${stem}`;
    return `${parts[0]}:core`;
  }
  if (ext === ".py" && parts.length >= 3 && parts[0] && parts[1]) {
    return `${parts[0]}:${parts[1].replace(/^_+/, "") || "core"}`;
  }
  return path.posix.dirname(rel) === "." ? "root" : (parts[0] ?? "core");
}

function matchTestsForBucket(
  area: string,
  bucket: { prodFiles: DiscoveredFile[]; testFiles: DiscoveredFile[]; symbols: string[] },
  testIndex: TestIndex,
): Array<{ readonly file: DiscoveredFile; readonly cases: Array<{ readonly name: string; readonly line: number }> }> {
  if (!area) throw new Error("area is required.");
  const matched: Array<{ readonly file: DiscoveredFile; readonly cases: Array<{ readonly name: string; readonly line: number }> }> = [];
  const seen = new Set<string>();

  for (const tf of bucket.testFiles) {
    seen.add(tf.rel);
    matched.push({ file: tf, cases: extractTestCases(tf) });
  }
  for (const pf of bucket.prodFiles) {
    if (pf.ext !== ".rs") continue;
    const inlineCases = extractTestCases(pf);
    if (inlineCases.length > 0 && !seen.has(pf.rel)) {
      seen.add(pf.rel);
      matched.push({ file: pf, cases: inlineCases });
    }
  }

  for (const sym of bucket.symbols) {
    if (sym.length < 5) continue;
    for (const hit of testIndex.byStem.get(sym.toLowerCase()) ?? []) {
      if (seen.has(hit.file.rel)) continue;
      seen.add(hit.file.rel);
      matched.push({ file: hit.file, cases: hit.cases });
    }
  }
  if (matched.length > 0) return matched.slice(0, 8);

  const cleanArea = area.replace(/^(?:plugin|crate|module|cmd|internal|caddyconfig):/, "").toLowerCase();
  const tailToken = cleanArea.split(":").pop() ?? cleanArea;
  const areaTokens = tailToken.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const symbolHints = bucket.symbols.filter((s) => s.length >= 4).slice(0, 6).map((s) => s.toLowerCase());

  const candidateSet = new Set<typeof testIndex.all[number]>();
  for (const key of [tailToken, slugifyIdentifier(tailToken), ...areaTokens, ...symbolHints]) {
    for (const hit of testIndex.byStem.get(key) ?? []) candidateSet.add(hit);
    for (const hit of testIndex.byToken.get(key) ?? []) candidateSet.add(hit);
  }
  const pool = candidateSet.size > 0 ? Array.from(candidateSet) : testIndex.all.slice(0, 120);

  for (const item of pool) {
    if (seen.has(item.file.rel)) continue;
    const hitArea =
      item.relLower.includes(tailToken) ||
      item.contentLower.includes(tailToken) ||
      item.relLower.includes(slugifyIdentifier(tailToken)) ||
      (areaTokens.length > 0 && areaTokens.every((tok) => item.relLower.includes(tok) || item.contentLower.includes(tok)));
    const hitSymbol = symbolHints.some((sym) => item.contentLower.includes(sym));
    if (hitArea || hitSymbol) {
      seen.add(item.file.rel);
      matched.push({ file: item.file, cases: item.cases });
      if (matched.length >= 5) break;
    }
  }
  return matched;
}

function buildFeatureRecords(
  area: string,
  bucket: { prodFiles: DiscoveredFile[]; testFiles: DiscoveredFile[]; symbols: string[]; fileSymbols: Map<string, string[]> },
  testIndex: TestIndex,
  bugfixFiles: ReadonlyMap<string, string>,
): ExtractionOutput {
  if (bucket.prodFiles.length === 0) return { features: [], tests: [], invariants: [] };
  const featureId = `feat.${slugifyIdentifier(area)}`;
  const sampleSymbols = bucket.symbols.slice(0, 6).join(", ");
  const feature: FeatureRecord = {
    id: featureId,
    area,
    name: `${area} capability`,
    summary: `Extracted from ${bucket.prodFiles.length} source file(s)${sampleSymbols ? ` exporting ${sampleSymbols}` : ""}.`,
    acceptanceCriteria: `Exports and behaviors in ${area} remain covered by linked tests and preserve extracted invariants.`,
    status: "active",
    source: "ast",
  };

  const testMap = new Map<string, FeatureTestLink>();
  const addTestLink = (tf: DiscoveredFile, cases: Array<{ readonly name: string; readonly line: number }>): void => {
    const pattern = cases[0]?.name ?? path.posix.basename(tf.rel);
    const rung = tf.rel.includes(".mbt.") ? "R3" : "R2";
    testMap.set(`${tf.rel}|${pattern}`, { featureId, testPath: tf.rel, testPattern: pattern, rung });
  };
  for (const hit of matchTestsForBucket(area, bucket, testIndex)) addTestLink(hit.file, hit.cases);

  const invariants: InvariantRecord[] = [];
  for (const pf of bucket.prodFiles) {
    const fileInvs = scanFileInvariants(pf, featureId);
    const fileSyms = bucket.fileSymbols.get(pf.rel) ?? [];
    const bugfixRef = bugfixFiles.get(pf.rel);
    for (const inv of fileInvs) {
      const rootHit = resolveRootTestForFile({
        prodFile: pf,
        symbols: fileSyms,
        invariantText: inv.statement,
        invariantLine: inv.line,
        testIndex,
      });
      if (rootHit) addTestLink(rootHit.file, rootHit.cases);
      const enriched: InvariantRecord = {
        ...inv,
        rootTestPath: rootHit?.file.rel ?? inv.rootTestPath,
        originKind: bugfixRef ? "bugfix" : (inv.originKind ?? "standard"),
        originRef: bugfixRef ?? inv.originRef,
      };
      invariants.push(enriched);
      if (invariants.length >= 250) break;
    }
    if (invariants.length >= 250) break;
  }
  return { features: [feature], tests: [...testMap.values()], invariants };
}

interface AreaBucket {
  readonly prodFiles: DiscoveredFile[];
  readonly testFiles: DiscoveredFile[];
  readonly symbols: string[];
  readonly fileSymbols: Map<string, string[]>;
}

function extractFromRepo(ctx: ScanContext): ExtractionOutput {
  if (!ctx.repoRoot) throw new Error("ScanContext.repoRoot is required.");
  const byArea = new Map<string, AreaBucket>();
  for (const file of ctx.files) {
    if (file.rel === "features/registry.sql") continue;
    if (!file.isTest && (NON_PROD_PREFIX.test(file.rel) || NON_PROD_SEGMENT.test(file.rel) || GENERATED_FILE_RE.test(file.rel))) continue;
    const area = areaFromPath(file.rel, file.ext);
    const bucket: AreaBucket = byArea.get(area) ?? { prodFiles: [], testFiles: [], symbols: [], fileSymbols: new Map() };
    if (file.isTest) {
      bucket.testFiles.push(file);
    } else {
      bucket.prodFiles.push(file);
      const syms = extractExportedSymbols(file);
      bucket.fileSymbols.set(file.rel, syms);
      for (const sym of syms) {
        if (!bucket.symbols.includes(sym)) bucket.symbols.push(sym);
      }
    }
    byArea.set(area, bucket);
  }

  const features: FeatureRecord[] = [];
  const tests: FeatureTestLink[] = [];
  const invariants: InvariantRecord[] = [];
  const testIndex = buildTestIndex(ctx.files.filter((f) => f.isTest));
  const bugfixFiles = detectBugfixOriginFiles(ctx.repoRoot);

  for (const [area, bucket] of [...byArea.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const out = buildFeatureRecords(area, bucket, testIndex, bugfixFiles);
    features.push(...out.features);
    tests.push(...out.tests);
    invariants.push(...out.invariants);
  }
  return { features, tests, invariants };
}

export default Plugin.define({
  id: "featlock.ast-scanner",
  async setup(ctx) {
    await ctx.extractor.transform((ed) => {
      ed.add({
        id: "featlock.ast-scanner.extractor",
        label: "Polyglot AST Feature, Test & Invariant Extractor",
        extract: extractFromRepo,
      });
    });
  },
});
