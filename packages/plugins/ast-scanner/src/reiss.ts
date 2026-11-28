import { execFileSync } from "node:child_process";

const KEYWORDS = new Set([
  "if",
  "elif",
  "else",
  "throw",
  "new",
  "return",
  "raise",
  "except",
  "as",
  "assert",
  "not",
  "and",
  "or",
  "in",
  "is",
  "typeof",
  "instanceof",
  "null",
  "undefined",
  "none",
  "true",
  "false",
  "err",
  "error",
  "exception",
  "valueerror",
  "typeerror",
  "runtimeerror",
  "apierror",
  "guard",
  "http",
  "fmt",
  "errors",
  "response",
  "ensure",
  "bail",
]);

const BUGFIX_MSG_RE = /\b(?:fix(?:es|ed)?|bug|revert|cve-\d{4}-\d+|security|vuln|regression|hotfix|patch)\b/i;

export function findEnclosingSymbol(lines: readonly string[], lineIndex: number, ext: string): string | undefined {
  if (lineIndex < 0 || lineIndex >= lines.length) return undefined;
  const maxBack = Math.max(0, lineIndex - 80);
  for (let i = lineIndex; i >= maxBack; i -= 1) {
    const raw = lines[i] ?? "";
    if (ext === ".py") {
      const m = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(raw);
      if (m?.[1]) return m[1];
      continue;
    }
    if (ext === ".rs") {
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(raw);
      if (m?.[1]) return m[1];
      continue;
    }
    if (ext === ".go") {
      const m = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(raw);
      if (m?.[1]) return m[1];
      continue;
    }
    if (ext === ".cs") {
      const m = /^\s*(?:public|private|protected|internal)\s+(?:(?:static|async|virtual|override|sealed|readonly)\s+)*[A-Za-z0-9_<>?[\]]+\s+([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\(/.exec(raw);
      if (m?.[1]) return m[1];
      continue;
    }
    const tsFn = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(raw);
    if (tsFn?.[1]) return tsFn[1];
    const tsArrow = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\(/.exec(raw);
    if (tsArrow?.[1]) return tsArrow[1];
    const tsMethod = /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/.exec(raw);
    if (tsMethod?.[1] && !["if", "for", "while", "switch", "catch"].includes(tsMethod[1])) return tsMethod[1];
  }
  return undefined;
}

export function computeAstFingerprint(raw: string): string {
  if (!raw) return "";
  const stripped = raw
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "STR")
    .replace(/\b\d+(?:\.\d+)?\b/g, "NUM")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (word) => {
      if (word === "STR" || word === "NUM") return word;
      if (KEYWORDS.has(word.toLowerCase())) return word.toLowerCase();
      if (/^[A-Z][A-Za-z0-9_]*(?:Error|Exception)$/.test(word)) return word;
      if (/^(?:ThrowIf\w*|NotNull\w*|Range|Errorf|New|Error|from)$/.test(word)) return word;
      return "ID";
    })
    .replace(/\s+/g, "");
  return stripped.slice(0, 140);
}

function charTrigrams(s: string): Set<string> {
  const out = new Set<string>();
  const padded = `  ${s}  `;
  for (let i = 0; i <= padded.length - 3; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const normA = a.replace(/\s+/g, " ").trim().toLowerCase();
  const normB = b.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  const ga = charTrigrams(normA);
  const gb = charTrigrams(normB);
  let inter = 0;
  for (const g of ga) {
    if (gb.has(g)) inter += 1;
  }
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(3));
}

export function detectBugfixOriginFiles(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!repoRoot) return out;
  try {
    const raw = execFileSync(
      "git",
      ["-C", repoRoot, "log", "-n", "60", "--name-only", "--pretty=format:COMMIT:%h:%s"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    );
    let currentRef: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("COMMIT:")) {
        const rest = trimmed.slice("COMMIT:".length);
        const colon = rest.indexOf(":");
        const sha = colon >= 0 ? rest.slice(0, colon) : rest;
        const msg = colon >= 0 ? rest.slice(colon + 1) : "";
        currentRef = BUGFIX_MSG_RE.test(msg) ? `commit:${sha}` : null;
      } else if (currentRef && !out.has(trimmed)) {
        out.set(trimmed, currentRef);
      }
    }
  } catch {
    return out;
  }
  return out;
}
