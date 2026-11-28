import { parseSync } from "oxc-parser";
import type { DiscoveredFile, FenceRung, InvariantRecord } from "@featlock/plugin";
import { maskSourceForGuards } from "./lexical.ts";
import { computeAstFingerprint, findEnclosingSymbol } from "./reiss.ts";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

export function slugifyIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizeGuardAnchor(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 140);
}

function hashAnchor(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
    return collectMatches(file.content, /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm, 80);
  }
  if (file.ext === ".py") {
    return collectMatches(file.content, /^(?:async\s+def|def|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/gm, 80);
  }
  if (file.ext === ".go") {
    return collectMatches(file.content, /^(?:func\s+(?:\([^)]+\)\s+)?|type\s+)([A-Z][A-Za-z0-9_]*)\b/gm, 80);
  }
  if (file.ext === ".cs") {
    return collectMatches(
      file.content,
      /\bpublic\s+(?:(?:static|sealed|abstract|partial|readonly|virtual|override|async)\s+)*(?:class|interface|record|struct|enum|void|[A-Za-z0-9_<>?]+)\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*(?:\(|\{|where|:)/g,
      80,
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
  readonly guardAnchor: string;
  readonly suffix: string;
  readonly fenceRung?: FenceRung;
}

function makeInv(input: InvariantInput): InvariantRecord {
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
    fenceRung: input.fenceRung ?? (input.kind === "db-trigger-guard" ? "R0" : "runtime"),
    astFingerprint: computeAstFingerprint(anchor),
    originKind: "standard",
    status: "active",
  };
}

function windowSlice(lines: readonly string[], start: number, span: number): string {
  return lines
    .slice(start, start + span)
    .map((l) => l.trim())
    .join(" ");
}

interface MaskedLines {
  readonly lines: readonly string[];
  readonly rawLines: readonly string[];
}

function matchTsJsGuard(
  file: DiscoveredFile,
  featureId: string,
  scan: MaskedLines,
  i: number,
): InvariantRecord | null {
  if (i < 0 || i >= scan.lines.length) throw new Error("Line index out of bounds.");
  const masked = (scan.lines[i] ?? "").trim();
  const raw = (scan.rawLines[i] ?? "").trim();
  const next3 = windowSlice(scan.lines, i, 3);
  const ln = i + 1;
  if (/\bCommand\.make\s*\(/.test(masked) && /\bCommand\.make\s*\(\s*["']([^"']+)["']/.test(raw)) {
    const cmd = /\bCommand\.make\s*\(\s*["']([^"']+)["']/.exec(raw)?.[1] ?? "command";
    return makeInv({ file, featureId, kind: "cli-contract", line: ln, confidence: 0.9, statement: `CLI subcommand '${cmd}' contract registered at ${file.rel}:${ln}`, guardAnchor: raw, suffix: `cli-${slugifyIdentifier(cmd)}` });
  }
  if (
    /\bif\s*\([^)]{2,140}\)/.test(masked) &&
    /\bthrow\s+(?:new\s+(?:[A-Z]\w*)?(?:Error|Exception)|[A-Z]\w*(?:Error|Exception)\.[A-Za-z_]\w*)\s*\(/.test(next3)
  ) {
    return makeInv({ file, featureId, kind: "precondition-guard", line: ln, confidence: 0.88, statement: `Precondition fail-closed guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "precondition" });
  }
  if (
    /\bif\s*\([^)]{2,140}\)/.test(masked) &&
    /\breturn\b[\s\S]{0,160}\b(?:[a-z]\w*(?:Rejection|Denied|Forbidden|Unauthorized|Invalid)\s*\(|new\s+Response\s*\([^)]*40[0134]\b)/.test(windowSlice(scan.lines, i, 5))
  ) {
    return makeInv({ file, featureId, kind: "fail-closed-return-guard", line: ln, confidence: 0.86, statement: `Fail-closed rejection guard: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "reject" });
  }
  if (/\b(?:assert\.ok|invariant)\s*\(/.test(masked)) {
    return makeInv({ file, featureId, kind: "runtime-invariant", line: ln, confidence: 0.88, statement: `Runtime invariant check: ${raw.slice(0, 110)}`, guardAnchor: raw, suffix: "invariant" });
  }
  return null;
}

function matchPolyglotLine(
  file: DiscoveredFile,
  featureId: string,
  scan: MaskedLines,
  i: number,
): InvariantRecord | null {
  const { lines, rawLines } = scan;
  if (i < 0 || i >= lines.length) throw new Error("Line index out of bounds.");
  const text = (lines[i] ?? "").trim();
  const raw = (rawLines[i] ?? "").trim();
  const next3 = windowSlice(lines, i, 3);
  const ln = i + 1;

  if (/\bRAISE\s*\(\s*ABORT\b/i.test(text)) {
    return makeInv({ file, featureId, kind: "db-trigger-guard", line: ln, confidence: 0.95, statement: `SQLite trigger aborts disallowed mutation at ${file.rel}:${ln}`, guardAnchor: raw, suffix: "sql-trigger" });
  }
  if (TS_JS_EXTS.has(file.ext)) return matchTsJsGuard(file, featureId, scan, i);
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

export function scanFileInvariants(file: DiscoveredFile, featureId: string): InvariantRecord[] {
  if (!featureId) throw new Error("featureId is required for invariant scanning.");
  if (file.isTest) return [];
  const found: InvariantRecord[] = [];
  const seenIds = new Set<string>();
  const rawLines = file.content.split("\n");
  const lines = maskSourceForGuards(file.content, file.ext).split("\n");
  const scan: MaskedLines = { lines, rawLines };
  const isRust = file.ext === ".rs";
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? "").trim();
    if (!text) continue;
    if (isRust && text.startsWith("#[cfg(test)]")) break;
    const inv = matchPolyglotLine(file, featureId, scan, i);
    if (inv && !seenIds.has(inv.id)) {
      seenIds.add(inv.id);
      const enclosingSymbol = findEnclosingSymbol(rawLines, i, file.ext);
      found.push(enclosingSymbol ? { ...inv, enclosingSymbol } : inv);
    }
  }
  if (found.length <= 24) return found;
  return found
    .toSorted((a, b) => {
      const diff = b.confidence - a.confidence;
      return diff !== 0 ? diff : a.line - b.line;
    })
    .slice(0, 24);
}
