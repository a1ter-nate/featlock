import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import repospecPlugin from "../../../packages/plugins/repospec-bridge/src/index.ts";

describe("@featlock/plugin-repospec-bridge unit contract", () => {
  test("extracts invariants from RepoSpec rules/*.sql files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-rs-unit-"));
    try {
      fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "rules", "01.sql"), "-- @id: rs:test\n-- @statement: Keep boundaries\nSELECT 1 WHERE 0;\n");
      const host = await createPluginHost({ includeBuiltins: false, plugins: [repospecPlugin] });
      try {
        const out = await host.extract(dir);
        expect(out.invariants.some((i) => i.source === "repospec" && i.id.includes("rs-test"))).toBe(true);
      } finally {
        await host.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
