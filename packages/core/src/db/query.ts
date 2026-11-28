import type {
  DuplicateCandidate,
  FeatureRecord,
  RegistryCounts,
  RegistrySnapshot,
} from "@featlock/plugin";

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "are", "was", "has"]);

function stemToken(raw: string): string {
  const tok = raw.toLowerCase();
  if (tok.length <= 4) return tok;
  if (tok.endsWith("ation") && tok.length > 7) return tok.slice(0, -5);
  if (tok.endsWith("ies") && tok.length > 5) return `${tok.slice(0, -3)}y`;
  if (tok.endsWith("ing") && tok.length > 6) return tok.slice(0, -3);
  if (tok.endsWith("ed") && tok.length > 5) return tok.slice(0, -2);
  if (tok.endsWith("es") && tok.length > 5) return tok.slice(0, -2);
  if (tok.endsWith("s") && !tok.endsWith("ss") && tok.length > 4) return tok.slice(0, -1);
  return tok;
}

export function tokenizeIdentifierText(text: string): string[] {
  if (!text) return [];
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const out: string[] = [];
  for (const part of expanded.split(" ")) {
    if (part.length < 3 || STOP_WORDS.has(part)) continue;
    out.push(stemToken(part));
  }
  return out;
}

export function countRegistry(snapshot: RegistrySnapshot): RegistryCounts {
  return {
    features: snapshot.features.length,
    tests: snapshot.tests.length,
    invariants: snapshot.invariants.length,
    auditEntries: snapshot.auditLog.length,
  };
}

function buildFeatureDocument(snapshot: RegistrySnapshot, feat: FeatureRecord): string {
  const invText = snapshot.invariants
    .filter((i) => i.featureId === feat.id)
    .slice(0, 12)
    .map((i) => `${i.file} ${i.enclosingSymbol ?? ""} ${i.statement}`)
    .join(" ");
  return `${feat.id} ${feat.area} ${feat.name} ${feat.summary} ${feat.acceptanceCriteria} ${feat.rationale ?? ""} ${invText}`;
}

export function queryRegistryFeatures(snapshot: RegistrySnapshot, term: string): FeatureRecord[] {
  if (!snapshot) throw new Error("RegistrySnapshot is required.");
  const tokens = tokenizeIdentifierText(term);
  if (tokens.length === 0) return [...snapshot.features];
  const scored: Array<{ readonly feat: FeatureRecord; readonly score: number }> = [];
  for (const feat of snapshot.features) {
    const docTokens = new Set(tokenizeIdentifierText(buildFeatureDocument(snapshot, feat)));
    const rawHay = `${feat.id} ${feat.area} ${feat.name} ${feat.summary} ${feat.acceptanceCriteria} ${feat.rationale ?? ""}`.toLowerCase();
    const hits = tokens.filter((t) => docTokens.has(t) || rawHay.includes(t));
    if (hits.length === tokens.length) {
      const idBonus = tokens.some((t) => feat.id.toLowerCase().includes(t) || feat.area.toLowerCase().includes(t)) ? 2 : 0;
      scored.push({ feat, score: hits.length + idBonus });
    }
  }
  return scored
    .toSorted((a, b) => (b.score !== a.score ? b.score - a.score : a.feat.id.localeCompare(b.feat.id)))
    .map((s) => s.feat);
}

export function findDuplicateFeatures(
  snapshot: RegistrySnapshot,
  description: string,
): DuplicateCandidate[] {
  if (!snapshot) throw new Error("RegistrySnapshot is required.");
  const queryList = tokenizeIdentifierText(description);
  const querySet = new Set(queryList);
  if (querySet.size === 0) return [];

  const active = snapshot.features.filter((f) => f.status !== "removed");
  if (active.length === 0) return [];

  const docs = active.map((feat) => {
    const tokens = tokenizeIdentifierText(buildFeatureDocument(snapshot, feat));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const areaTokens = new Set(tokenizeIdentifierText(`${feat.id} ${feat.area}`));
    return { feat, tokens, tf, areaTokens };
  });

  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.tokens.length;
    for (const term of d.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgLen = Math.max(1, totalLen / docs.length);
  const k1 = 1.2;
  const bm25B = 0.75;
  const nDocs = docs.length;

  const results: DuplicateCandidate[] = [];
  for (const d of docs) {
    const matched: string[] = [];
    let bm25 = 0;
    let maxBm25 = 0;
    for (const q of querySet) {
      const idf = Math.log((nDocs - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5) + 1) + 0.5;
      maxBm25 += idf * ((k1 + 1) / (k1 + 1));
      const freq = d.tf.get(q) ?? 0;
      if (freq > 0) {
        matched.push(q);
        bm25 += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - bm25B + (bm25B * d.tokens.length) / avgLen)));
      }
    }
    if (matched.length === 0) continue;
    const normBm25 = Math.min(1, bm25 / Math.max(1e-9, maxBm25));
    const structuralBoost = matched.some((m) => d.areaTokens.has(m)) ? 0.12 : 0;
    const overlapRatio = matched.length / Math.min(querySet.size, Math.max(1, d.tf.size));
    const score = Number(Math.min(1, Math.max(0, normBm25 * 0.55 + overlapRatio * 0.45 + structuralBoost)).toFixed(3));
    if (matched.length >= 2 || score >= 0.4) {
      results.push({ featureId: d.feat.id, name: d.feat.name, score, matchedTokens: matched.toSorted() });
    }
  }
  return results.toSorted((a, b) => (b.score !== a.score ? b.score - a.score : a.featureId.localeCompare(b.featureId)));
}
