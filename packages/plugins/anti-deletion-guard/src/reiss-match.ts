import type { InvariantRecord } from "@featlock/plugin";

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

export function computeLineFingerprint(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "STR")
    .replace(/\b\d+(?:\.\d+)?\b/g, "NUM")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (word) => {
      if (word === "STR" || word === "NUM") return word;
      if (KEYWORDS.has(word.toLowerCase())) return word.toLowerCase();
      if (/^[A-Z][A-Za-z0-9_]*(?:Error|Exception)$/.test(word)) return word;
      if (/^(?:ThrowIf\w*|NotNull\w*|Range|Errorf|New|Error|from)$/.test(word)) return word;
      return "ID";
    })
    .replace(/\s+/g, "")
    .slice(0, 140);
}

function buildTrigramSet(s: string): Set<string> {
  const out = new Set<string>();
  const pad = `  ${s}  `;
  for (let i = 0; i <= pad.length - 3; i += 1) out.add(pad.slice(i, i + 3));
  return out;
}

export function trigramJaccard(a: string, b: string): number {
  const normA = a.replace(/\s+/g, " ").trim().toLowerCase();
  const normB = b.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  const ga = buildTrigramSet(normA);
  const gb = buildTrigramSet(normB);
  let inter = 0;
  for (const g of ga) {
    if (gb.has(g)) inter += 1;
  }
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchesMultiSignalAnchor(inv: InvariantRecord, rawFileContent: string): boolean {
  if (!inv.guardAnchor || !rawFileContent) return false;
  const expectedFp = inv.astFingerprint || computeLineFingerprint(inv.guardAnchor);
  if (!expectedFp || expectedFp.length < 6) return false;
  const lines = rawFileContent.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) continue;
    if (computeLineFingerprint(trimmed) !== expectedFp) continue;
    if (trigramJaccard(inv.guardAnchor, trimmed) < 0.45) continue;
    if (inv.enclosingSymbol) {
      const start = Math.max(0, i - 80);
      const windowText = lines.slice(start, i + 1).join("\n");
      if (windowText.includes(inv.enclosingSymbol)) return true;
      continue;
    }
    return true;
  }
  return false;
}
