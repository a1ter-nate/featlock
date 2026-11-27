import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRepo, Registry, State } from "@featlock/core";

describe("@featlock/core unit contract", () => {
  test("State.createKeyedDomain replays transforms and Registry counts empty snapshots", () => {
    const domain = State.createKeyedDomain<{ readonly id: string }>("core-unit");
    const reg = domain.transform((ed) => ed.add({ id: "k1" }));
    expect(domain.get().map((x) => x.id)).toEqual(["k1"]);
    reg.dispose();
    expect(domain.get()).toEqual([]);
    expect(Registry.count({ features: [], tests: [], invariants: [], auditLog: [] }).features).toBe(0);
    expect(() => discoverRepo("/nonexistent/featlock/path/xyz")).toThrow();
  });

  test("discoverRepo excludes examples, fixtures, templates, and caught negative controls from isTest", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-discover-unit-"));
    try {
      fs.mkdirSync(path.join(tmp, "examples/csharp/caught"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "fixtures"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "examples/csharp/caught/BadTests.Tests.cs"), "public class BadTests {}\n", "utf8");
      fs.writeFileSync(path.join(tmp, "fixtures/sample.test.ts"), "test('fixture', () => {});\n", "utf8");
      fs.writeFileSync(path.join(tmp, "tests/auth.test.ts"), "test('real', () => {});\n", "utf8");

      const scan = discoverRepo(tmp);
      const testPaths = scan.files.filter((f) => f.isTest).map((f) => f.rel);
      expect(testPaths).toEqual(["tests/auth.test.ts"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
