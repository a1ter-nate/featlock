import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = path.resolve(import.meta.dir, "../..");
const BUILTIN_MANIFEST = "packages/core/src/plugin/internal.ts";
const REQUIRED_PLUGINS = [
  "ast-scanner",
  "repospec-bridge",
  "veristack-bridge",
  "invariant-passes",
  "anti-deletion-guard",
  "harnesses",
  "registry-cli",
  "studio",
  "config",
] as const;

const REQUIRED_DOMAINS = [
  "language",
  "extractor",
  "invariantScanner",
  "guard",
  "analytics",
  "agentPass",
  "harness",
  "reporter",
  "studio",
  "command",
] as const;

function isSourceTs(name: string): boolean {
  const hasExt = name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts");
  return hasExt && !name.endsWith(".d.ts") && !name.endsWith(".test.ts");
}

function collectFiles(relDir: string): string[] {
  const start = path.join(ROOT, relDir);
  if (!fs.existsSync(start)) return [];
  const out: string[] = [];
  const stack: string[] = [start];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && isSourceTs(e.name)) out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
    }
  }
  return out.toSorted();
}

function countLines(files: readonly string[]): number {
  return files.reduce((sum, f) => sum + fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").length, 0);
}

function listImports(relFile: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, relFile), "utf8");
  const parsed = parseSync(relFile, text, { lang: "ts" });
  const specs: string[] = [];
  for (const imp of parsed.module.staticImports) specs.push(imp.moduleRequest.value);
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest) specs.push(entry.moduleRequest.value);
    }
  }
  return specs;
}

describe("Law 1: Tight Core & Real Package Boundary (No Barrel Illusion) [REQ-FLK-PLUGINS-01]", () => {
  test("dedicated packages/plugin and packages/core exist and are exported from root package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      workspaces?: string[];
      exports?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(fs.existsSync(path.join(ROOT, "packages/plugin/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "packages/core/package.json"))).toBe(true);
    expect(pkg.exports?.["./plugin"]).toBeDefined();
    expect(pkg.exports?.["./core"]).toBeDefined();
    expect(pkg.workspaces).toContain("packages/plugins/*");
    expect(Object.keys(pkg.dependencies ?? {}).length).toBeLessThanOrEqual(2);
  });

  test("packages/plugin SDK has zero upward imports from packages/core or packages/plugins", () => {
    const files = collectFiles("packages/plugin/src");
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      for (const spec of listImports(f)) {
        if (spec.includes("@featlock/core") || spec.includes("packages/core") || spec.includes("packages/plugins")) {
          violations.push(`${f} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("core kernel never imports feature plugins outside packages/core/src/plugin/internal.ts", () => {
    const files = collectFiles("packages/core/src");
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      if (f === BUILTIN_MANIFEST) continue;
      for (const spec of listImports(f)) {
        if (spec.includes("/plugins/") || spec.startsWith("@featlock/plugin-")) {
          violations.push(`${f} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("Law 2, 3 & 4: Dogfooded Built-In Plugins, Replayable Domains & Zero Backdoors", () => {
  test("all 9 first-party built-in plugins exist under packages/plugins/*, use Plugin.define, and import zero core internals", () => {
    const present = fs
      .readdirSync(path.join(ROOT, "packages/plugins"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const req of REQUIRED_PLUGINS) expect(present).toContain(req);

    const violations: string[] = [];
    for (const f of collectFiles("packages/plugins")) {
      for (const spec of listImports(f)) {
        if (spec.includes("@featlock/core") || spec.includes("packages/core") || spec.startsWith("../../../src")) {
          violations.push(`${f} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);

    for (const dir of REQUIRED_PLUGINS) {
      const combined = collectFiles(`packages/plugins/${dir}`)
        .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
        .join("\n");
      expect(combined.match(/\b(?:Plugin\.define|definePlugin)\s*\(/) !== null).toBe(true);
    }
  });

  test("built-in manifest enforces pre/post/guarded boot with zero backdoor analytics exports", () => {
    const text = fs.readFileSync(path.join(ROOT, BUILTIN_MANIFEST), "utf8");
    expect(text).toContain("GUARDED_PLUGIN_IDS");
    expect(/\bpre\b/.test(text)).toBe(true);
    expect(/\bpost\b/.test(text)).toBe(true);
    expect(text).not.toContain("GuardAnalytics");
  });

  test("core implements replayable State.create and SDK exposes all 10 replayable domains including studio", () => {
    const stateSrc = fs.readFileSync(path.join(ROOT, "packages/core/src/state.ts"), "utf8");
    expect(stateSrc).toContain("transform");
    expect(stateSrc).toContain("batch");
    expect(stateSrc).toContain("group");

    const sdkCombined = collectFiles("packages/plugin/src")
      .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
      .join("\n");
    const missing = REQUIRED_DOMAINS.filter((d) => !new RegExp(`\\b${d}\\b`).test(sdkCombined));
    expect(missing).toEqual([]);
  });
});

describe("Law 9: Core Kernel Tightness Budget", () => {
  test("core kernel stays tight (<= 2500 LOC) and thin CLI shim (src/) <= 150 LOC", () => {
    const kernelLines = countLines([...collectFiles("packages/core/src"), ...collectFiles("packages/plugin/src")]);
    const cliLines = countLines(collectFiles("src"));
    expect(kernelLines).toBeLessThanOrEqual(2500);
    expect(cliLines).toBeLessThanOrEqual(150);
  });
});
