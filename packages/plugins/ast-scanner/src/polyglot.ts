import { parseSync } from "oxc-parser";
import type { DiscoveredFile, InvariantRecord } from "@featlock/plugin";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

export function slugifyIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function collectMatches(content: string, regex: RegExp, limit: number): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(regex)) {
    const sym = (m[1] ?? "").trim();
    if (sym && !out.includes(sym)) out.push(sym);
    if (out.length >= limit) break;
  }
  return out;
}

export function extractExportedSymbols(file: DiscoveredFile): string[] {
  if (!file.content) return [];
  if (TS_JS_EXTS.has(file.ext)) {
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
  if (file.ext === ".rs") {
    return collectMatches(file.content, /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm, 12);
  }
  if (file.ext === ".py") {
    return collectMatches(file.content, /^(?:async\s+def|def|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/gm, 12);
  }
  if (file.ext === ".go") {
    return collectMatches(file.content, /^(?:func\s+(?:\([^)]+\)\s+)?|type\s+)([A-Z][A-Za-z0-9_]*)\b/gm, 12);
  }
  if (file.ext === ".cs") {
    return collectMatches(
      file.content,
      /\bpublic\s+(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:class|interface|record|struct|enum)\s+([A-Z][A-Za-z0-9_]*)/g,
      12,
    );
  }
  return [];
}

export function extractTestCases(file: DiscoveredFile): Array<{ readonly name: string; readonly line: number }> {
  if (!file.content) return [];
  const cases: Array<{ readonly name: string; readonly line: number }> = [];
  const push = (name: string, index: number): void => {
    const clean = name.trim();
    if (!clean) return;
    const line = file.content.slice(0, index).split("\n").length;
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

interface InvariantInput {
  readonly file: DiscoveredFile;
  readonly featureId: string;
  readonly kind: string;
  readonly line: number;
  readonly confidence: number;
  readonly statement: string;
  readonly suffix: string;
}

function makeInv(input: InvariantInput): InvariantRecord {
  return {
    id: `inv:ast:${input.suffix}:${slugifyIdentifier(input.file.rel)}:${input.line}`,
    featureId: input.featureId,
    kind: input.kind,
    statement: input.statement,
    file: input.file.rel,
    line: input.line,
    confidence: input.confidence,
    source: "ast",
    status: "active",
  };
}

function matchPolyglotLine(
  file: DiscoveredFile,
  featureId: string,
  lines: readonly string[],
  i: number,
): InvariantRecord | null {
  if (i < 0 || i >= lines.length) throw new Error("Line index out of bounds.");
  const text = (lines[i] ?? "").trim();
  const nextWindow = `${text} ${(lines[i + 1] ?? "").trim()} ${(lines[i + 2] ?? "").trim()}`;
  const ln = i + 1;

  if (/\bRAISE\s*\(\s*ABORT\b/i.test(text)) {
    return makeInv({ file, featureId, kind: "db-trigger-guard", line: ln, confidence: 0.95, statement: `SQLite trigger aborts disallowed mutation at ${file.rel}:${ln}`, suffix: "sql-trigger" });
  }
  if (TS_JS_EXTS.has(file.ext)) {
    if (/\bCommand\.make\s*\(\s*["']([^"']+)["']/.test(text)) {
      const cmd = /\bCommand\.make\s*\(\s*["']([^"']+)["']/.exec(text)?.[1] ?? "command";
      return makeInv({ file, featureId, kind: "cli-contract", line: ln, confidence: 0.9, statement: `CLI subcommand '${cmd}' contract registered at ${file.rel}:${ln}`, suffix: `cli-${slugifyIdentifier(cmd)}` });
    }
    if (/\bif\s*\([^)]{2,140}\)/.test(text) && /\bthrow\s+new\s+(?:[A-Z]\w*)?Error\s*\(/.test(nextWindow)) {
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.85, statement: `Precondition fail-closed guard: ${text.slice(0, 110)}`, suffix: "precondition" });
    }
    if (/\b(?:assert\.ok|invariant)\s*\(/.test(text)) {
      return makeInv({ file, featureId, kind: "runtime-invariant", line: ln, confidence: 0.88, statement: `Runtime invariant check: ${text.slice(0, 110)}`, suffix: "invariant" });
    }
    return null;
  }
  if (file.ext === ".rs") {
    if (/\b(?:assert!|assert_eq!|assert_ne!|debug_assert!|ensure!|bail!)\s*\(/.test(text)) {
      return makeInv({ file, featureId, kind: "rust-assert-guard", line: ln, confidence: 0.9, statement: `Rust invariant assertion: ${text.slice(0, 110)}`, suffix: "rs-assert" });
    }
    if (/^if\s+[^{]{2,120}\{/.test(text) && /\breturn\s+Err\s*\(/.test(nextWindow)) {
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.84, statement: `Rust error guard: ${text.slice(0, 110)}`, suffix: "rs-err" });
    }
    return null;
  }
  if (file.ext === ".py") {
    if (/^if\s+[^:]{2,120}:/.test(text) && /\braise\s+[A-Z][A-Za-z0-9_]*\s*\(/.test(nextWindow)) {
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.86, statement: `Python precondition guard: ${text.slice(0, 110)}`, suffix: "py-raise" });
    }
    if (/^assert\s+[^#]{3,120}/.test(text)) {
      return makeInv({ file, featureId, kind: "python-assert-guard", line: ln, confidence: 0.85, statement: `Python invariant assertion: ${text.slice(0, 110)}`, suffix: "py-assert" });
    }
    return null;
  }
  if (file.ext === ".go") {
    if (/^if\s+[^{]{2,120}\{/.test(text) && /\b(?:fmt\.Errorf|errors\.New)\s*\(/.test(nextWindow)) {
      return makeInv({ file, featureId, kind: "go-error-guard", line: ln, confidence: 0.84, statement: `Go error guard: ${text.slice(0, 110)}`, suffix: "go-err" });
    }
    return null;
  }
  if (file.ext === ".cs") {
    if (/\b(?:ArgumentNullException|ArgumentOutOfRangeException|ArgumentException|ObjectDisposedException)\.ThrowIf\w*\s*\(|\bGuard\.(?:NotNull|Range|NotNullOrEmpty)\s*\(/.test(text)) {
      return makeInv({ file, featureId, kind: "csharp-guard-clause", line: ln, confidence: 0.92, statement: `C# guard clause: ${text.slice(0, 110)}`, suffix: "cs-guard" });
    }
    if (/^if\s*\([^)]{2,140}\)/.test(text) && /\bthrow\s+new\s+[A-Z]\w*Exception\s*\(/.test(nextWindow)) {
      return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.85, statement: `C# precondition guard: ${text.slice(0, 110)}`, suffix: "cs-throw" });
    }
  }
  return null;
}

export function scanFileInvariants(file: DiscoveredFile, featureId: string): InvariantRecord[] {
  if (!featureId) throw new Error("featureId is required for invariant scanning.");
  if (file.isTest) return [];
  const found: InvariantRecord[] = [];
  const lines = file.content.split("\n");
  const isRust = file.ext === ".rs";
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? "").trim();
    if (!text) continue;
    if (isRust && text.startsWith("#[cfg(test)]")) break;
    const inv = matchPolyglotLine(file, featureId, lines, i);
    if (inv) {
      found.push(inv);
      if (found.length >= 6) break;
    }
  }
  return found;
}
