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

const NON_PROD_PREFIX =
  /^(?:\.github|examples|samples|snippets|templates|fixtures|testdata|__fixtures__|bench|benchmarks|benchsuite|perf-measures|fuzz|docs|tools|scripts|build|eng|pkg|ci|caddytest)\//i;
const NON_PROD_SEGMENT = /(?:^|\/)(?:snippets|samples|benchmarks|__fixtures__|testdata)\//i;
const GENERATED_FILE_RE = /\.(?:d\.ts|pb\.go|g\.cs|generated\.[a-z]+)$/i;

function areaFromPath(rel: string, ext: string): string {
  const parts = rel.split("/");
  if (parts[0] === "packages" && parts[1] === "plugins" && parts[2]) return `plugin:${parts[2]}`;
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "crates" && parts[1]) return `crate:${parts[1]}`;
  if (parts[0] === "modules" && parts[1]) return `module:${parts[1]}`;
  if ((parts[0] === "cmd" || parts[0] === "internal" || parts[0] === "caddyconfig") && parts.length >= 3 && parts[1]) {
    return `${parts[0]}:${parts[1]}`;
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
  allTestFiles: readonly DiscoveredFile[],
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
  if (matched.length > 0) return matched.slice(0, 5);

  const cleanArea = area.replace(/^(?:plugin|crate|module|cmd|internal|caddyconfig):/, "").toLowerCase();
  const tailToken = cleanArea.split(":").pop() ?? cleanArea;
  const areaTokens = tailToken.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const symbolHints = bucket.symbols.filter((s) => s.length >= 4).slice(0, 6).map((s) => s.toLowerCase());

  for (const tf of allTestFiles) {
    if (seen.has(tf.rel)) continue;
    const hay = `${tf.rel}\n${tf.content}`.toLowerCase();
    const hitArea =
      hay.includes(tailToken) ||
      hay.includes(slugifyIdentifier(tailToken)) ||
      (areaTokens.length > 0 && areaTokens.every((tok) => hay.includes(tok)));
    const hitSymbol = symbolHints.some((sym) => hay.includes(sym));
    if (hitArea || hitSymbol) {
      seen.add(tf.rel);
      matched.push({ file: tf, cases: extractTestCases(tf) });
      if (matched.length >= 5) break;
    }
  }
  return matched;
}

function buildFeatureRecords(
  area: string,
  bucket: { prodFiles: DiscoveredFile[]; testFiles: DiscoveredFile[]; symbols: string[] },
  allTestFiles: readonly DiscoveredFile[],
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

  const tests: FeatureTestLink[] = [];
  for (const hit of matchTestsForBucket(area, bucket, allTestFiles)) {
    const pattern = hit.cases[0]?.name ?? path.posix.basename(hit.file.rel);
    const rung = hit.file.rel.includes(".mbt.") ? "R3" : "R2";
    tests.push({ featureId, testPath: hit.file.rel, testPattern: pattern, rung });
  }

  const invariants: InvariantRecord[] = [];
  for (const pf of bucket.prodFiles) {
    invariants.push(...scanFileInvariants(pf, featureId));
    if (invariants.length >= 25) break;
  }
  return { features: [feature], tests, invariants: invariants.slice(0, 25) };
}

function extractFromRepo(ctx: ScanContext): ExtractionOutput {
  if (!ctx.repoRoot) throw new Error("ScanContext.repoRoot is required.");
  const byArea = new Map<string, { prodFiles: DiscoveredFile[]; testFiles: DiscoveredFile[]; symbols: string[] }>();
  for (const file of ctx.files) {
    if (!file.isTest && (NON_PROD_PREFIX.test(file.rel) || NON_PROD_SEGMENT.test(file.rel) || GENERATED_FILE_RE.test(file.rel))) continue;
    const area = areaFromPath(file.rel, file.ext);
    const bucket = byArea.get(area) ?? { prodFiles: [], testFiles: [], symbols: [] };
    if (file.isTest) {
      bucket.testFiles.push(file);
    } else {
      bucket.prodFiles.push(file);
      for (const sym of extractExportedSymbols(file)) {
        if (!bucket.symbols.includes(sym)) bucket.symbols.push(sym);
      }
    }
    byArea.set(area, bucket);
  }

  const features: FeatureRecord[] = [];
  const tests: FeatureTestLink[] = [];
  const invariants: InvariantRecord[] = [];
  const allTestFiles = ctx.files.filter((f) => f.isTest);

  for (const [area, bucket] of [...byArea.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const out = buildFeatureRecords(area, bucket, allTestFiles);
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
