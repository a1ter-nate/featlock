import type {
  DuplicateCandidate,
  FeatureRecord,
  RegistryCounts,
  RegistrySnapshot,
} from "@featlock/plugin";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((tok) => tok.length >= 3);
}

export function countRegistry(snapshot: RegistrySnapshot): RegistryCounts {
  return {
    features: snapshot.features.length,
    tests: snapshot.tests.length,
    invariants: snapshot.invariants.length,
    auditEntries: snapshot.auditLog.length,
  };
}

export function queryRegistryFeatures(snapshot: RegistrySnapshot, term: string): FeatureRecord[] {
  const tokens = tokenize(term);
  if (tokens.length === 0) return [...snapshot.features];
  return snapshot.features.filter((f) => {
    const hay = `${f.id} ${f.area} ${f.name} ${f.summary} ${f.acceptanceCriteria}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

export function findDuplicateFeatures(
  snapshot: RegistrySnapshot,
  description: string,
): DuplicateCandidate[] {
  const queryTokens = new Set(tokenize(description));
  if (queryTokens.size === 0) return [];
  const results: DuplicateCandidate[] = [];
  for (const f of snapshot.features) {
    if (f.status === "removed") continue;
    const featTokens = new Set(tokenize(`${f.id} ${f.area} ${f.name} ${f.summary}`));
    const matched: string[] = [];
    for (const tok of queryTokens) {
      if (featTokens.has(tok)) matched.push(tok);
    }
    const denom = Math.min(queryTokens.size, Math.max(1, featTokens.size));
    const score = Number((matched.length / denom).toFixed(3));
    if (matched.length >= 2 || score >= 0.4) {
      results.push({ featureId: f.id, name: f.name, score, matchedTokens: matched });
    }
  }
  return results.toSorted((a, b) => {
    const diff = b.score - a.score;
    return diff !== 0 ? diff : a.featureId.localeCompare(b.featureId);
  });
}
