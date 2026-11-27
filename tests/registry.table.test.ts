import { describe, expect, test } from "bun:test";
import { Registry } from "@featlock/core";
import type { RegistrySnapshot } from "@featlock/plugin";

const BASE_SNAPSHOT: RegistrySnapshot = {
  features: [
    {
      id: "feat.auth.jwt",
      area: "auth",
      name: "JWT Token Verification",
      summary: "Validates signed bearer tokens and rejects expired claims",
      acceptanceCriteria: "Rejects invalid signatures and expired tokens",
      status: "active",
      source: "manual",
    },
    {
      id: "feat.billing.invoice",
      area: "billing",
      name: "Invoice PDF Export",
      summary: "Generates deterministic tax invoices for settled orders",
      acceptanceCriteria: "Totals match ledger entries",
      status: "active",
      source: "manual",
    },
    {
      id: "feat.legacy.xml",
      area: "legacy",
      name: "Legacy XML Feed",
      summary: "Retired XML syndication endpoint",
      acceptanceCriteria: "Removed under ADR-002",
      status: "removed",
      source: "manual",
      adrRef: "ADR-002",
      removalReason: "Replaced by JSON feed",
    },
  ],
  tests: [
    { featureId: "feat.auth.jwt", testPath: "tests/auth.test.ts", testPattern: "verifies jwt", rung: "R2" },
    { featureId: "feat.billing.invoice", testPath: "tests/billing.test.ts", testPattern: "exports pdf", rung: "R2" },
  ],
  invariants: [
    {
      id: "inv:auth:no-alg-none",
      featureId: "feat.auth.jwt",
      kind: "precondition-guard",
      statement: "Rejects unsigned alg=none JWT tokens",
      file: "src/auth.ts",
      line: 12,
      confidence: 0.99,
      source: "ast",
      status: "active",
    },
  ],
  auditLog: [
    { featureId: "feat.auth.jwt", action: "added", actor: "agent", summary: "Initial registration" },
  ],
};

describe("Registry Query, Duplicate & SQL Serialization Tables", () => {
  test.each([
    { term: "jwt bearer", expectedIds: ["feat.auth.jwt"] },
    { term: "invoice pdf", expectedIds: ["feat.billing.invoice"] },
    { term: "", expectedIds: ["feat.auth.jwt", "feat.billing.invoice", "feat.legacy.xml"] },
    { term: "nonexistent-xyz", expectedIds: [] },
  ])("queryFeatures('$term') returns expected feature ids", ({ term, expectedIds }) => {
    const found = Registry.queryFeatures(BASE_SNAPSHOT, term).map((f) => f.id);
    expect(found).toEqual([...expectedIds]);
  });

  test.each([
    { desc: "signed jwt bearer token verification", expectedTop: "feat.auth.jwt", minCount: 1 },
    { desc: "deterministic tax invoice pdf export", expectedTop: "feat.billing.invoice", minCount: 1 },
    { desc: "legacy xml syndication endpoint", expectedTop: undefined, minCount: 0 },
    { desc: "a b", expectedTop: undefined, minCount: 0 },
  ])("findDuplicates('$desc') scores active features and ignores removed ones", ({ desc, expectedTop, minCount }) => {
    const dups = Registry.findDuplicates(BASE_SNAPSHOT, desc);
    expect(dups.length).toBeGreaterThanOrEqual(minCount);
    expect(dups[0]?.featureId).toBe(expectedTop);
    for (const d of dups) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(1);
    }
  });

  test("serializeSql and loadFromSql preserve all counts and escape single quotes", () => {
    const quoted: RegistrySnapshot = {
      ...BASE_SNAPSHOT,
      features: [
        ...BASE_SNAPSHOT.features,
        {
          id: "feat.quote.escape",
          area: "core",
          name: "User's Quote Guard",
          summary: "Handles O'Brien's input safely",
          acceptanceCriteria: "Never breaks SQLite 'escaping'",
          status: "active",
          source: "manual",
        },
      ],
    };
    const roundTripped = Registry.loadFromSql(Registry.serializeSql(quoted));
    expect(Registry.count(roundTripped)).toEqual(Registry.count(quoted));
    expect(roundTripped.features.find((f) => f.id === "feat.quote.escape")?.summary).toBe("Handles O'Brien's input safely");
  });
});
