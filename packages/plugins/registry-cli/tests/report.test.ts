import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import { anonymizeSnippet, buildIssueUrl, buildReportPayload, redactText } from "../src/report.ts";

const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "..", "..", "src", "cli.ts");

describe("@featlock/plugin-registry-cli report command", () => {
  test("redactText scrubs absolute home paths, workspace roots, secrets, JWTs, DB URLs, and emails", () => {
    const raw = [
      "Path: /Users/alice/work/client-app/src/pay.ts",
      "Win: C:\\Users\\bob\\proj\\api.ts",
      "Auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig1234567890",
      `Key: ${["ghp", "1234567890abcdef1234567890abcdef"].join("_")}`,
      "Db: postgres://admin:supersecret@db.internal:5432/prod",
      "Env: STRIPE_SECRET=live_abc12345",
      "Mail: dev@client-corp.io",
    ].join("\n");
    const clean = redactText(raw, "/Users/alice/work/client-app");
    expect(clean).not.toContain("alice");
    expect(clean).not.toContain("bob");
    expect(clean).not.toContain("supersecret");
    expect(clean).not.toContain("ghp_");
    expect(clean).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(clean).not.toContain("live_abc12345");
    expect(clean).not.toContain("dev@client-corp.io");
    expect(clean).toContain("<repo>/src/pay.ts");
    expect(clean).toContain("<redacted>");
    expect(clean).toContain("<redacted-email>");
  });

  test("anonymizeSnippet rewrites non-keyword identifiers and string literals while keeping syntax", () => {
    const code = 'if (!clientSecret) throw new Error("proprietary failure");';
    const anon = anonymizeSnippet(code);
    expect(anon).not.toContain("clientSecret");
    expect(anon).not.toContain("proprietary");
    expect(anon).toContain('if (!id1) throw new Error("<str>");');
  });

  test("buildIssueUrl clamps oversized bodies under 7500 chars with truncation note", () => {
    const shortRes = buildIssueUrl({ kind: "fp", title: "[FP] rule-x", body: "short body" });
    expect(shortRes.truncated).toBe(false);
    expect(shortRes.url).toContain("template=false-positive.yml");

    const hugeBody = "line of detail\n".repeat(1200);
    const longRes = buildIssueUrl({ kind: "bug", title: "[BUG] big", body: hugeBody });
    expect(longRes.truncated).toBe(true);
    expect(longRes.url.length).toBeLessThanOrEqual(7500);
    expect(longRes.url).toContain("template=bug-report.yml");
    expect(decodeURIComponent(longRes.url)).toContain("Truncated");
  });

  test("CLI report dry-run, --anonymize, --out, --json purity, gh fallback, and check footer hint", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-report-cli-"));
    try {
      fs.mkdirSync(path.join(tmp, "src", "secret"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "src", "secret", "vault.ts"),
        [
          'export function openVault(vaultToken: string) {',
          '  if (!vaultToken) throw new Error("missing vault token for ops@corp.test");',
          "  return vaultToken;",
          "}",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(path.join(tmp, "tests", "vault.test.ts"), 'test("openVault", () => {});\n', "utf8");

      const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true });
      const ext = await host.extract(tmp);
      await host.writeRegistry(tmp, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
      const built = buildReportPayload({
        repoRoot: tmp,
        args: ["--rule", "invariant-guard-dropped-in-code", "--file", "src/secret/vault.ts:2", "--anonymize", "--reason", "valid refactor"],
        registry: await host.readRegistry(tmp),
      });
      await host.dispose();
      expect(built.snippet).not.toContain("vaultToken");
      expect(built.snippet).not.toContain("ops@corp.test");
      expect(built.invariantMeta?.id).toContain("inv:ast:precondition");

      const dryRun = spawnSync(
        "bun",
        [CLI_PATH, "report", "--rule", "invariant-guard-dropped-in-code", "--file", "src/secret/vault.ts:2", "--reason", "test dry run"],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("Dry-run preview (nothing sent)");
      expect(dryRun.stdout).not.toContain("ops@corp.test");

      const outFile = path.join(tmp, "report.md");
      const outRun = spawnSync(
        "bun",
        [CLI_PATH, "report", "--rule", "test-rule", "--file", "src/secret/vault.ts:2", "--out", outFile],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(outRun.status).toBe(0);
      expect(fs.existsSync(outFile)).toBe(true);

      const jsonRun = spawnSync(
        "bun",
        [CLI_PATH, "report", "--rule", "test-rule", "--file", "src/secret/vault.ts:2", "--json"],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(jsonRun.status).toBe(0);
      const parsed = JSON.parse(jsonRun.stdout) as { rule: string; url: string };
      expect(parsed.rule).toBe("test-rule");
      expect(parsed.url).toContain("https://github.com/a1ter-nate/featlock/issues/new");

      const submitFallback = spawnSync(
        "bun",
        [CLI_PATH, "report", "--rule", "test-rule", "--file", "src/secret/vault.ts:2", "--submit"],
        { cwd: tmp, encoding: "utf8", env: { ...process.env, FEATLOCK_GH_BIN: "nonexistent-gh-bin-xyz" } },
      );
      expect(submitFallback.status).toBe(0);
      expect(submitFallback.stderr).toContain("https://github.com/a1ter-nate/featlock/issues/new");

      fs.writeFileSync(path.join(tmp, "src", "secret", "vault.ts"), "export function openVault(v: string) { return v; }\n", "utf8");
      const checkHuman = spawnSync("bun", [CLI_PATH, "check", "."], { cwd: tmp, encoding: "utf8" });
      expect(checkHuman.status).toBe(1);
      expect(checkHuman.stdout).toContain("False positive or tool bug? Run: featlock report --rule ");

      const checkJson = spawnSync("bun", [CLI_PATH, "check", ".", "--json"], { cwd: tmp, encoding: "utf8" });
      expect(checkJson.status).toBe(1);
      expect(() => JSON.parse(checkJson.stdout)).not.toThrow();
      expect(checkJson.stdout).not.toContain("False positive or tool bug?");

      const q1 = spawnSync(
        "bun",
        [CLI_PATH, "report", "--local", "--rule", "rule-alpha", "--file", "src/secret/vault.ts:1", "--anonymize", "--reason", "first hit"],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(q1.status).toBe(0);
      expect(q1.stdout).toContain("1 entry/entries queued");

      const q2 = spawnSync(
        "bun",
        [CLI_PATH, "report", "--local", "--rule", "rule-alpha", "--file", "src/secret/vault.ts:1", "--anonymize", "--reason", "first hit"],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(q2.status).toBe(0);
      expect(q2.stdout).toContain("2 entry/entries queued");

      const q3 = spawnSync(
        "bun",
        [CLI_PATH, "report", "--local", "--kind", "bug", "--rule", "rule-beta", "--reason", "second rule"],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(q3.status).toBe(0);
      expect(q3.stdout).toContain("3 entry/entries queued");

      const queueFile = path.join(tmp, ".verification", "tool-feedback.jsonl");
      expect(fs.existsSync(queueFile)).toBe(true);

      const flushJson = spawnSync("bun", [CLI_PATH, "report", "--flush", "--json"], { cwd: tmp, encoding: "utf8" });
      expect(flushJson.status).toBe(0);
      const flushed = JSON.parse(flushJson.stdout) as {
        totalEntries: number;
        groups: Array<{ rule: string; count: number; samples: unknown[] }>;
        cleared: boolean;
      };
      expect(flushed.totalEntries).toBe(3);
      expect(flushed.groups).toHaveLength(2);
      expect(flushed.groups[0]?.rule).toBe("rule-alpha");
      expect(flushed.groups[0]?.count).toBe(2);
      expect(flushed.groups[0]?.samples).toHaveLength(1);
      expect(flushed.cleared).toBe(false);
      expect(fs.existsSync(queueFile)).toBe(true);

      const flushFailSubmit = spawnSync(
        "bun",
        [CLI_PATH, "report", "--flush", "--submit"],
        { cwd: tmp, encoding: "utf8", env: { ...process.env, FEATLOCK_GH_BIN: "nonexistent-gh-bin-xyz" } },
      );
      expect(flushFailSubmit.status).toBe(0);
      expect(fs.existsSync(queueFile)).toBe(true);

      const flushClear = spawnSync("bun", [CLI_PATH, "report", "--flush", "--clear", "--json"], { cwd: tmp, encoding: "utf8" });
      expect(flushClear.status).toBe(0);
      expect((JSON.parse(flushClear.stdout) as { cleared: boolean }).cleared).toBe(true);
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
