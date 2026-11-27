import path from "node:path";
import type { DiscoveredFile } from "@featlock/plugin";
import { extractTestCases } from "./polyglot.ts";

function stemOf(relPath: string): string {
  return path.posix
    .basename(relPath, path.posix.extname(relPath))
    .replace(/^_+/, "")
    .replace(/\.(?:test|spec)$/i, "")
    .replace(/(?:_test|tests?)$/i, "")
    .replace(/^test_/, "")
    .toLowerCase();
}

function invariantKeywords(statement: string): string[] {
  const stop = new Set(["precondition", "guard", "fail", "closed", "error", "return", "throw", "raise", "assert", "string", "typeof", "value", "const", "invalid", "python", "rust", "csharp", "clause", "invariant", "assertion"]);
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((tok) => tok.length >= 4 && !stop.has(tok))
    .slice(0, 6);
}

function findEnclosingSymbol(file: DiscoveredFile, line: number): string | null {
  const lines = file.content.split("\n");
  const start = Math.max(0, Math.min(lines.length - 1, line - 1));
  const floor = Math.max(0, start - 35);
  for (let i = start; i >= floor; i -= 1) {
    const raw = (lines[i] ?? "").trim();
    const m =
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw) ??
      /^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/.exec(raw) ??
      /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw) ??
      /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(raw) ??
      /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(raw) ??
      /\b(?:public|internal|private|protected)\s+(?:(?:static|sealed|abstract|virtual|override|async)\s+)*[A-Za-z0-9_<>?]+\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\(/.exec(raw);
    if (m?.[1] && m[1].length >= 4) return m[1];
  }
  return null;
}

interface RootScoreContext {
  readonly prodFile: DiscoveredFile;
  readonly symbols: readonly string[];
  readonly enclosingSymbol: string | null;
  readonly keywords: readonly string[];
}

function scoreTestForRoot(ctx: RootScoreContext, tf: DiscoveredFile): number {
  if (!tf.rel) throw new Error("Test file path is required.");
  const prodDir = path.posix.dirname(ctx.prodFile.rel);
  const testDir = path.posix.dirname(tf.rel);
  const prodStem = stemOf(ctx.prodFile.rel);
  const testStem = stemOf(tf.rel);
  const tfLower = tf.rel.toLowerCase();
  const contentLower = tf.content.toLowerCase();
  let score = 0;

  if (testDir === prodDir) {
    score += 8;
    if (prodStem && (testStem === prodStem || testStem.startsWith(`${prodStem}_`) || testStem.startsWith(prodStem))) {
      score += 12;
    }
  } else if (prodStem && prodStem !== "index" && prodStem !== "mod" && prodStem !== "lib") {
    if (testStem === prodStem || testStem.includes(prodStem)) score += 10;
  }

  const parentName = path.posix.basename(prodDir).toLowerCase();
  if (parentName && parentName.length >= 4 && parentName !== "src" && tfLower.includes(`/${parentName}/`)) {
    score += 8;
  } else if (parentName && parentName.length >= 3 && parentName !== "src" && tfLower.includes(parentName)) {
    score += 4;
  }

  if (ctx.enclosingSymbol && contentLower.includes(ctx.enclosingSymbol.toLowerCase())) {
    score += 18;
  }

  let symHits = 0;
  for (const sym of ctx.symbols) {
    if (sym.length >= 4 && contentLower.includes(sym.toLowerCase())) {
      symHits += 1;
      if (symHits >= 2) break;
    }
  }
  score += symHits * 5;

  let kwHits = 0;
  for (const kw of ctx.keywords) {
    if (contentLower.includes(kw) || tfLower.includes(kw)) {
      kwHits += 1;
      if (kwHits >= 2) break;
    }
  }
  score += kwHits * 5;
  return score;
}

export interface RootTestQuery {
  readonly prodFile: DiscoveredFile;
  readonly symbols: readonly string[];
  readonly invariantText: string;
  readonly invariantLine: number;
  readonly allTestFiles: readonly DiscoveredFile[];
}

export function resolveRootTestForFile(query: RootTestQuery): DiscoveredFile | undefined {
  if (!query.prodFile.rel) throw new Error("prodFile.rel is required.");
  if (query.prodFile.ext === ".rs" && extractTestCases(query.prodFile).length > 0) return query.prodFile;

  const ctx: RootScoreContext = {
    prodFile: query.prodFile,
    symbols: query.symbols,
    enclosingSymbol: findEnclosingSymbol(query.prodFile, query.invariantLine),
    keywords: invariantKeywords(query.invariantText),
  };
  let best: DiscoveredFile | undefined;
  let bestScore = 0;
  for (const tf of query.allTestFiles) {
    const score = scoreTestForRoot(ctx, tf);
    if (score > bestScore || (score === bestScore && score > 0 && best && tf.rel.localeCompare(best.rel) < 0)) {
      bestScore = score;
      best = tf;
    }
  }
  return bestScore >= 6 ? best : undefined;
}
