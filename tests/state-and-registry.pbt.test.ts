import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Registry, State } from "@featlock/core";
import type { FeatureRecord, RegistrySnapshot } from "@featlock/plugin";

const safeSlug = fc.stringMatching(/^[a-z][a-z0-9-]{2,14}$/);
const safeText = fc.stringMatching(/^[A-Za-z0-9 '._:-]{3,40}$/);

const featureArb: fc.Arbitrary<FeatureRecord> = fc.record({
  id: safeSlug.map((s) => `feat.${s}`),
  area: safeSlug,
  name: safeText,
  summary: safeText,
  acceptanceCriteria: safeText,
  status: fc.constantFrom<"active" | "deprecated" | "removed">("active", "deprecated", "removed"),
  source: fc.constantFrom("ast", "manual", "repospec"),
});

describe("Property-Based Tests: Replayable State & SQLite Registry Determinism", () => {
  test("State.create replay and disposal always converge to remaining active transforms", () => {
    fc.assert(
      fc.property(fc.uniqueArray(safeSlug, { minLength: 1, maxLength: 12 }), (ids) => {
        const domain = State.createKeyedDomain<{ readonly id: string; readonly v: number }>("pbt-domain");
        const regs = ids.map((id, idx) =>
          domain.transform((ed) => {
            ed.add({ id, v: idx });
          }),
        );
        expect(domain.get().map((x) => x.id)).toEqual(ids);
        const half = Math.floor(ids.length / 2);
        for (let i = 0; i < half; i += 1) regs[i]?.dispose();
        expect(domain.get().map((x) => x.id)).toEqual(ids.slice(half));
        for (let i = half; i < ids.length; i += 1) regs[i]?.dispose();
        expect(domain.get()).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });

  test("Registry SQL serialization is deterministic and round-trips through SQLite losslessly", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(featureArb, { selector: (f) => f.id, minLength: 0, maxLength: 8 }),
        (features) => {
          const snapshot: RegistrySnapshot = {
            features,
            tests: features.map((f) => ({
              featureId: f.id,
              testPath: `tests/${f.area}.test.ts`,
              testPattern: f.name,
              rung: "R2",
            })),
            invariants: features.map((f, idx) => ({
              id: `inv:pbt:${f.id}:${idx}`,
              featureId: f.id,
              kind: "precondition-guard",
              statement: f.summary,
              file: `src/${f.area}.ts`,
              line: idx + 1,
              confidence: 0.9,
              source: "ast",
              status: f.status,
            })),
            auditLog: [],
          };
          const sql1 = Registry.serializeSql(snapshot);
          const loaded = Registry.loadFromSql(sql1);
          const sql2 = Registry.serializeSql(loaded);
          expect(sql2).toBe(sql1);
          expect(Registry.count(loaded)).toEqual(Registry.count(snapshot));
        },
      ),
      { numRuns: 40 },
    );
  });

  test("findDuplicates always returns sorted scores within [0, 1] and never includes removed features", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(featureArb, { selector: (f) => f.id, minLength: 1, maxLength: 8 }),
        safeText,
        (features, query) => {
          const snap: RegistrySnapshot = { features, tests: [], invariants: [], auditLog: [] };
          const dups = Registry.findDuplicates(snap, query);
          const removedIds = new Set(features.filter((f) => f.status === "removed").map((f) => f.id));
          const allValid = dups.every(
            (cur, i) =>
              !removedIds.has(cur.featureId) &&
              cur.score >= 0 &&
              cur.score <= 1 &&
              (i === 0 || (dups[i - 1]?.score ?? 1) >= cur.score),
          );
          expect(allValid).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });
});
