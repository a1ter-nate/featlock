import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "@featlock/core";

describe("R4 Real-Engine SQLite Trigger & Persistence Integration Slice", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-r4-sqlite-"));
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("materializes real bun:sqlite database with BEFORE DELETE RAISE(ABORT) anti-deletion triggers", () => {
    Registry.recordNew({
      repoRoot: tmpDir,
      feature: {
        id: "feat.r4.engine",
        area: "engine",
        name: "R4 SQLite Engine Feature",
        summary: "Verifies real SQLite trigger enforcement",
        acceptanceCriteria: "Active features and invariants cannot be deleted directly",
        status: "active",
        source: "manual",
      },
      tests: [{ featureId: "feat.r4.engine", testPath: "tests/r4.test.ts", testPattern: "engine", rung: "R4" }],
      invariants: [
        {
          id: "inv:r4:trigger",
          featureId: "feat.r4.engine",
          kind: "sqlite-trigger",
          statement: "Active rows resist DELETE",
          file: "packages/core/src/db/schema.ts",
          line: 1,
          confidence: 1,
          source: "manual",
          fenceRung: "R2",
          status: "active",
        },
      ],
    });
    const materialized = Registry.materializeDb(tmpDir);
    const db = new Database(materialized.dbPath);
    try {
      expect(() => db.run("DELETE FROM features WHERE id = 'feat.r4.engine'")).toThrow();
      expect(() => db.run("DELETE FROM invariants WHERE id = 'inv:r4:trigger'")).toThrow();
      const count = db.query("SELECT COUNT(*) as c FROM features WHERE status = 'active'").get() as { c: number };
      expect(count.c).toBe(1);
    } finally {
      db.close();
    }
  });
});
