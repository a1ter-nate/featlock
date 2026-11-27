import path from "node:path";
import { parseSync } from "oxc-parser";
import {
  Plugin,
  type DiscoveredFile,
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

function areaFromPath(rel: string): string {
  const parts = rel.split("/");
  if (parts[0] === "packages" && parts[1] === "plugins" && parts[2]) return `plugin:${parts[2]}`;
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "src" && parts[1] && !parts[1].includes(".")) return parts[1];
  if (parts[0] === "tests" && parts[1] && !parts[1].includes(".")) return parts[1];
  return path.posix.dirname(rel) === "." ? "root" : parts[0] ?? "core";
}

function extractTestCases(file: DiscoveredFile): Array<{ readonly name: string; readonly line: number }> {
  const cases: Array<{ readonly name: string; readonly line: number }> = [];
  const regex = /\b(?:test|it|describe)\s*\(\s*(["'`])([^"'`\n]{3,140})\1/g;
  for (const m of file.content.matchAll(regex)) {
    const title = (m[2] ?? "").trim();
    if (!title) continue;
    const line = file.content.slice(0, m.index ?? 0).split("\n").length;
    cases.push({ name: title, line });
  }
  return cases;
}

function extractExportedSymbols(file: DiscoveredFile): string[] {
  if (![".ts", ".tsx", ".mts", ".js", ".mjs"].includes(file.ext)) return [];
  const parsed = parseSync(file.rel, file.content, { lang: file.ext === ".tsx" ? "tsx" : "ts" });
  const symbols: string[] = [];
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      const name = entry.exportName.name;
      if (name && name !== "default" && !symbols.includes(name)) symbols.push(name);
    }
  }
  return symbols;
}

function scanFileInvariants(file: DiscoveredFile, featureId: string): InvariantRecord[] {
  if (file.isTest) return [];
  const found: InvariantRecord[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? "").trim();
    if (!text) continue;
    if (/\bRAISE\s*\(\s*ABORT\b/i.test(text)) {
      found.push({
        id: `inv:ast:sql-trigger:${slugify(file.rel)}:${i + 1}`,
        featureId,
        kind: "db-trigger-guard",
        statement: `SQLite trigger aborts disallowed mutation at ${file.rel}:${i + 1}`,
        file: file.rel,
        line: i + 1,
        confidence: 0.95,
        source: "ast",
        status: "active",
      });
    } else if (/\bif\s*\([^)]{3,120}\)\s*(?:return\s+)?throw\s+new\s+(?:[A-Z]\w*)?Error\s*\(/.test(text)) {
      found.push({
        id: `inv:ast:precondition:${slugify(file.rel)}:${i + 1}`,
        featureId,
        kind: "precondition-guard",
        statement: `Precondition fail-closed guard: ${text.slice(0, 120)}`,
        file: file.rel,
        line: i + 1,
        confidence: 0.82,
        source: "ast",
        status: "active",
      });
    } else if (/\bCommand\.make\s*\(\s*["']([^"']+)["']/.test(text)) {
      const match = /\bCommand\.make\s*\(\s*["']([^"']+)["']/.exec(text);
      const cmd = match?.[1] ?? "command";
      found.push({
        id: `inv:ast:cli-contract:${slugify(cmd)}:${i + 1}`,
        featureId,
        kind: "cli-contract",
        statement: `CLI subcommand '${cmd}' contract registered at ${file.rel}:${i + 1}`,
        file: file.rel,
        line: i + 1,
        confidence: 0.9,
        source: "ast",
        status: "active",
      });
    }
  }
  return found.slice(0, 8);
}

const NON_PROD_PREFIX = /^(?:examples|templates|fixtures|testdata|__fixtures__|benchmarks|tools|scripts)\//i;

function extractFromRepo(ctx: ScanContext): ExtractionOutput {
  const byArea = new Map<string, { prodFiles: DiscoveredFile[]; testFiles: DiscoveredFile[]; symbols: string[] }>();
  for (const file of ctx.files) {
    if (!file.isTest && NON_PROD_PREFIX.test(file.rel)) continue;
    const area = areaFromPath(file.rel);
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
    if (bucket.prodFiles.length === 0) continue;
    const featureId = `feat.${slugify(area)}`;
    const sampleSymbols = bucket.symbols.slice(0, 6).join(", ");
    features.push({
      id: featureId,
      area,
      name: `${area} capability`,
      summary: `Extracted from ${bucket.prodFiles.length} source file(s)${sampleSymbols ? ` exporting ${sampleSymbols}` : ""}.`,
      acceptanceCriteria: `Exports and behaviors in ${area} remain covered by linked tests and preserve extracted invariants.`,
      status: "active",
      source: "ast",
    });

    const cleanArea = area.replace(/^plugin:/, "").toLowerCase();
    const areaTokens = cleanArea.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const matchedTests = bucket.testFiles.length > 0
      ? bucket.testFiles
      : allTestFiles.filter((tf) => {
          const hay = `${tf.rel}\n${tf.content}`.toLowerCase();
          if (hay.includes(cleanArea) || hay.includes(slugify(area))) return true;
          return areaTokens.length > 0 && areaTokens.every((tok) => hay.includes(tok));
        });

    for (const tf of matchedTests.slice(0, 5)) {
      const cases = extractTestCases(tf);
      const pattern = cases[0]?.name ?? path.posix.basename(tf.rel);
      const rung = tf.rel.includes(".mbt.") ? "R3" : tf.rel.includes(".pbt.") ? "R2" : "R2";
      tests.push({ featureId, testPath: tf.rel, testPattern: pattern, rung });
    }

    for (const pf of bucket.prodFiles) {
      invariants.push(...scanFileInvariants(pf, featureId));
    }
  }

  return { features, tests, invariants };
}

export default Plugin.define({
  id: "featlock.ast-scanner",
  async setup(ctx) {
    await ctx.extractor.transform((ed) => {
      ed.add({
        id: "featlock.ast-scanner.extractor",
        label: "AST Feature, Test & Invariant Extractor",
        extract: extractFromRepo,
      });
    });
  },
});
