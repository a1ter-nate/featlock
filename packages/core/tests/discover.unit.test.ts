import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRepo } from "../src/discover.ts";

describe("@featlock/core discoverRepo pure unit tests", () => {
  test("discovers custom language extensions and ignores .agents/.amp directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-discover-unit-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, ".agents", "skills"), { recursive: true });
      fs.mkdirSync(path.join(tmp, ".amp"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "core.zig"), "pub fn main() void {}\n");
      fs.writeFileSync(path.join(tmp, "src", "core_spec.zig"), "test \"ok\" {}\n");
      fs.writeFileSync(path.join(tmp, ".agents", "skills", "ignore.ts"), "export const x = 1;\n");
      fs.writeFileSync(path.join(tmp, ".amp", "ignore.ts"), "export const y = 2;\n");

      const ctx = discoverRepo(tmp, {
        languages: [{ id: "zig", extensions: [".zig"], isTestFile: (rel) => rel.endsWith("_spec.zig") }],
      });
      expect(ctx.files.map((f) => f.rel).toSorted()).toEqual(["src/core.zig", "src/core_spec.zig"]);
      expect(ctx.files.find((f) => f.rel === "src/core_spec.zig")?.isTest).toBe(true);
      expect(ctx.files.find((f) => f.rel === "src/core.zig")?.isTest).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
