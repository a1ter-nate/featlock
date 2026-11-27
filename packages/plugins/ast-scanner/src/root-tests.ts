import path from "node:path";
import type { DiscoveredFile } from "@featlock/plugin";
import { extractTestCases } from "./polyglot.ts";

export interface IndexedTestFile {
  readonly file: DiscoveredFile;
  readonly dir: string;
  readonly stem: string;
  readonly relLower: string;
  readonly contentLower: string;
  readonly cases: Array<{ readonly name: string; readonly line: number }>;
}

export interface TestIndex {
  readonly all: readonly IndexedTestFile[];
  readonly byDir: ReadonlyMap<string, readonly IndexedTestFile[]>;
  readonly byStem: ReadonlyMap<string, readonly IndexedTestFile[]>;
  readonly byToken: ReadonlyMap<string, readonly IndexedTestFile[]>;
}

function stemOf(relPath: string): string {
  return path.posix
    .basename(relPath, path.posix.extname(relPath))
    .replace(/^_+/, "")
    .replace(/\.(?:test|spec)$/i, "")
    .replace(/(?:_test|tests?)$/i, "")
    .replace(/^test_/, "")
    .toLowerCase();
}

function addToBucket(map: Map<string, IndexedTestFile[]>, key: string, item: IndexedTestFile): void {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/[a-z][a-z0-9]{3,40}/g)) {
    tokens.add(m[0]);
    if (tokens.size >= 500) break;
  }
  return tokens;
}

export function buildTestIndex(allTestFiles: readonly DiscoveredFile[]): TestIndex {
  if (!Array.isArray(allTestFiles)) throw new Error("allTestFiles must be an array.");
  const all: IndexedTestFile[] = [];
  const byDir = new Map<string, IndexedTestFile[]>();
  const byStem = new Map<string, IndexedTestFile[]>();
  const byToken = new Map<string, IndexedTestFile[]>();

  for (const file of allTestFiles) {
    const dir = path.posix.dirname(file.rel);
    const stem = stemOf(file.rel);
    const relLower = file.rel.toLowerCase();
    const contentLower = file.content.toLowerCase();
    const item: IndexedTestFile = { file, dir, stem, relLower, contentLower, cases: extractTestCases(file) };
    all.push(item);
    addToBucket(byDir, dir, item);
    addToBucket(byStem, stem, item);
    for (const part of stem.split(/[^a-z0-9]+/).filter((p) => p.length >= 4)) addToBucket(byStem, part, item);
    for (const tok of extractTokens(`${relLower} ${contentLower.slice(0, 16_000)}`)) addToBucket(byToken, tok, item);
  }
  return { all, byDir, byStem, byToken };
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
  readonly prodDir: string;
  readonly prodStem: string;
  readonly parentName: string;
  readonly symbols: readonly string[];
  readonly enclosingSymbol: string | null;
  readonly keywords: readonly string[];
}

function scoreTestForRoot(ctx: RootScoreContext, tf: IndexedTestFile): number {
  if (!tf.file.rel) throw new Error("Test file path is required.");
  let score = 0;

  if (tf.dir === ctx.prodDir) {
    score += 8;
    if (ctx.prodStem && (tf.stem === ctx.prodStem || tf.stem.startsWith(`${ctx.prodStem}_`) || tf.stem.startsWith(ctx.prodStem))) {
      score += 12;
    }
  } else if (ctx.prodStem && ctx.prodStem !== "index" && ctx.prodStem !== "mod" && ctx.prodStem !== "lib") {
    if (tf.stem === ctx.prodStem || tf.stem.includes(ctx.prodStem)) score += 10;
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
      if (symHits >= 2) break;
    }
  }
  score += symHits * 5;

  let kwHits = 0;
  for (const kw of ctx.keywords) {
    if (tf.contentLower.includes(kw) || tf.relLower.includes(kw)) {
      kwHits += 1;
      if (kwHits >= 2) break;
    }
  }
  score += kwHits * 5;
  return score;
}

function gatherCandidates(ctx: RootScoreContext, index: TestIndex): IndexedTestFile[] {
  const seen = new Set<string>();
  const out: IndexedTestFile[] = [];
  const addList = (list: readonly IndexedTestFile[] | undefined): void => {
    if (!list) return;
    for (const item of list) {
      if (seen.has(item.file.rel)) continue;
      seen.add(item.file.rel);
      out.push(item);
      if (out.length >= 60) return;
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
    for (const part of cleanSym.split(/[^a-z0-9]+/).filter((p) => p.length >= 4)) addList(index.byToken.get(part));
  }
  for (const sym of ctx.symbols.slice(0, 6)) {
    const cleanSym = sym.toLowerCase().replace(/^_+/, "");
    addList(index.byToken.get(cleanSym));
    for (const part of cleanSym.split(/[^a-z0-9]+/).filter((p) => p.length >= 4)) addList(index.byToken.get(part));
  }
  for (const kw of ctx.keywords) addList(index.byToken.get(kw));
  if (out.length === 0 && index.all.length <= 20) addList(index.all);
  return out;
}

export interface RootTestQuery {
  readonly prodFile: DiscoveredFile;
  readonly symbols: readonly string[];
  readonly invariantText: string;
  readonly invariantLine: number;
  readonly testIndex: TestIndex;
}

export function resolveRootTestForFile(query: RootTestQuery): IndexedTestFile | undefined {
  if (!query.prodFile.rel) throw new Error("prodFile.rel is required.");
  if (query.prodFile.ext === ".rs") {
    const inlineCases = extractTestCases(query.prodFile);
    if (inlineCases.length > 0) {
      return {
        file: query.prodFile,
        dir: path.posix.dirname(query.prodFile.rel),
        stem: stemOf(query.prodFile.rel),
        relLower: query.prodFile.rel.toLowerCase(),
        contentLower: "",
        cases: inlineCases,
      };
    }
  }

  const prodDir = path.posix.dirname(query.prodFile.rel);
  const ctx: RootScoreContext = {
    prodDir,
    prodStem: stemOf(query.prodFile.rel),
    parentName: path.posix.basename(prodDir).toLowerCase(),
    symbols: query.symbols,
    enclosingSymbol: findEnclosingSymbol(query.prodFile, query.invariantLine),
    keywords: invariantKeywords(query.invariantText),
  };
  const candidates = gatherCandidates(ctx, query.testIndex);
  let best: IndexedTestFile | undefined;
  let bestScore = 0;
  for (const tf of candidates) {
    const score = scoreTestForRoot(ctx, tf);
    if (score > bestScore || (score === bestScore && score > 0 && best && tf.file.rel.localeCompare(best.file.rel) < 0)) {
      bestScore = score;
      best = tf;
    }
  }
  return bestScore >= 6 ? best : undefined;
}
