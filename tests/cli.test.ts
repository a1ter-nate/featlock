import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = path.resolve(import.meta.dir, "..", "src", "cli.ts");

function runCli(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", [CLI_PATH, ...args], { cwd, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("FeatLock CLI Boundary Integration Suite", () => {
  let tmpRepo = "";

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-cli-"));
    fs.mkdirSync(path.join(tmpRepo, "src", "orders"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "src", "orders", "service.ts"),
      'export function createOrder(qty: number) { if (qty <= 0) throw new Error("qty"); return qty; }\n',
    );
    fs.writeFileSync(
      path.join(tmpRepo, "tests", "orders.test.ts"),
      'import { test } from "bun:test";\ntest("createOrder validates qty", () => {});\n',
    );
  });

  afterAll(() => {
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test("extract --write, sync, query, check-dup, check, agent-pass, plugins, and hooks round-trip via CLI", () => {
    const help = runCli(["--help"], tmpRepo);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("featlock extract");

    const ext = runCli(["extract", "--write", "--json"], tmpRepo);
    expect(ext.status).toBe(0);
    const extJson = JSON.parse(ext.stdout) as { total: { features: number; tests: number; invariants: number } };
    expect(extJson.total.features).toBeGreaterThanOrEqual(1);
    expect(extJson.total.invariants).toBeGreaterThanOrEqual(1);

    const chk = runCli(["check", "--json"], tmpRepo);
    expect(chk.status).toBe(0);
    expect((JSON.parse(chk.stdout) as { ok: boolean }).ok).toBe(true);

    const sync = runCli(["sync", "--json"], tmpRepo);
    expect(sync.status).toBe(0);

    const query = runCli(["query", "orders", "--json"], tmpRepo);
    expect(query.status).toBe(0);
    expect((JSON.parse(query.stdout) as { matches: unknown[] }).matches.length).toBeGreaterThanOrEqual(1);

    const dup = runCli(["check-dup", "orders capability", "--json"], tmpRepo);
    expect(dup.status).toBe(0);
    expect((JSON.parse(dup.stdout) as { duplicates: unknown[] }).duplicates.length).toBeGreaterThanOrEqual(1);

    const passes = runCli(["agent-pass", "--json"], tmpRepo);
    expect(passes.status).toBe(0);
    expect((JSON.parse(passes.stdout) as { passes: unknown[] }).passes.length).toBe(4);

    const plugins = runCli(["plugins", "--json"], tmpRepo);
    expect(plugins.status).toBe(0);
    expect((JSON.parse(plugins.stdout) as { plugins: Array<{ id: string }> }).plugins.some((p) => p.id === "featlock.guard.anti-deletion")).toBe(true);

    expect(runCli(["hooks", "on", "--json"], tmpRepo).status).toBe(0);
    expect(runCli(["hooks", "status", "--json"], tmpRepo).status).toBe(0);
    expect(runCli(["hooks", "off", "--json"], tmpRepo).status).toBe(0);

    fs.mkdirSync(path.join(tmpRepo, "orders"), { recursive: true });
    const queryWithSameNameDir = runCli(["query", "orders", "--json"], tmpRepo);
    expect(queryWithSameNameDir.status).toBe(0);
    expect((JSON.parse(queryWithSameNameDir.stdout) as { matches: unknown[] }).matches.length).toBeGreaterThanOrEqual(1);

    const queryViaRepoFlag = runCli(["query", "orders", "--repo", tmpRepo, "--json"], os.tmpdir());
    expect(queryViaRepoFlag.status).toBe(0);
    expect((JSON.parse(queryViaRepoFlag.stdout) as { matches: unknown[] }).matches.length).toBeGreaterThanOrEqual(1);

    expect(runCli(["unknown-subcommand"], tmpRepo).status).toBe(2);
  });
});
