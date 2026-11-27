import fs from "node:fs";
import path from "node:path";
import { Plugin, type HarnessSpec } from "@featlock/plugin";

const HOOK_SCRIPT_CONTENT = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const localBin = path.resolve("node_modules/.bin/featlock");
const cmd = fs.existsSync(localBin) ? localBin : "bunx";
const args = fs.existsSync(localBin) ? ["check", "."] : ["featlock", "check", "."];
const res = spawnSync(cmd, args, { encoding: "utf8" });
if (res.error || res.status !== 0) {
  process.stderr.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  if (res.error) process.stderr.write(String(res.error.message || res.error) + "\\n");
  process.stderr.write("\\nFEATLOCK GUARD: Feature/invariant integrity check failed. Do NOT silently delete features or invariants.\\n");
  process.exit(2);
}
`;

const AGENT_RULE_BLOCK = `<!-- featlock:start -->
## FeatLock Feature & Invariant Guard Rules
- Before implementing any new capability, run \`featlock query <topic>\` and \`featlock check-dup "<summary>"\` so you do not duplicate an existing feature.
- On every change that adds or improves product behavior, automatically record it with \`featlock record-new\` or \`featlock record-improvement\` in \`features/registry.sql\`.
- NEVER delete an active feature, unlink its tests, or delete an active invariant without explicit human confirmation, an ADR reference, and \`ALLOW_FEATURE_REMOVAL=1\`.
<!-- featlock:end -->
`;

interface HarnessConfigBinding {
  readonly configRel: string;
  readonly eventKey: "Stop" | "stop";
  readonly format: "nested" | "flat";
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function entryHasMarker(entry: unknown, marker: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  return JSON.stringify(entry).includes(marker);
}

function wireJsonHookConfig(
  repoRoot: string,
  binding: HarnessConfigBinding,
  relScript: string,
): boolean {
  if (!repoRoot || !relScript) throw new Error("repoRoot and relScript are required.");
  const absConfig = path.join(repoRoot, binding.configRel);
  const root = readJsonObject(absConfig);
  if (binding.format === "flat" && root.version === undefined) root.version = 1;
  const hooksObj =
    root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
      ? { ...(root.hooks as Record<string, unknown>) }
      : {};
  const list = Array.isArray(hooksObj[binding.eventKey])
    ? [...(hooksObj[binding.eventKey] as unknown[])]
    : [];
  if (list.some((item) => entryHasMarker(item, relScript))) return false;
  const command = `node ${relScript}`;
  const entry =
    binding.format === "nested"
      ? { hooks: [{ type: "command", command }] }
      : { command };
  list.push(entry);
  hooksObj[binding.eventKey] = list;
  root.hooks = hooksObj;
  fs.mkdirSync(path.dirname(absConfig), { recursive: true });
  fs.writeFileSync(absConfig, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return true;
}

function unwireJsonHookConfig(
  repoRoot: string,
  binding: HarnessConfigBinding,
  relScript: string,
): boolean {
  const absConfig = path.join(repoRoot, binding.configRel);
  if (!fs.existsSync(absConfig)) return false;
  const root = readJsonObject(absConfig);
  const hooksObj =
    root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
      ? { ...(root.hooks as Record<string, unknown>) }
      : null;
  if (!hooksObj || !Array.isArray(hooksObj[binding.eventKey])) return false;
  const before = hooksObj[binding.eventKey] as unknown[];
  const after = before.filter((item) => !entryHasMarker(item, relScript));
  if (after.length === before.length) return false;
  hooksObj[binding.eventKey] = after;
  root.hooks = hooksObj;
  fs.writeFileSync(absConfig, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return true;
}

function isJsonHookWired(
  repoRoot: string,
  binding: HarnessConfigBinding,
  relScript: string,
): boolean {
  const absConfig = path.join(repoRoot, binding.configRel);
  if (!fs.existsSync(absConfig)) return false;
  const root = readJsonObject(absConfig);
  const hooksObj =
    root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : null;
  if (!hooksObj || !Array.isArray(hooksObj[binding.eventKey])) return false;
  return (hooksObj[binding.eventKey] as unknown[]).some((item) => entryHasMarker(item, relScript));
}

function ensureAgentRule(filePath: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (existing.includes("<!-- featlock:start -->")) return false;
  const next = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${AGENT_RULE_BLOCK}` : AGENT_RULE_BLOCK;
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function removeAgentRule(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, "utf8");
  if (!existing.includes("<!-- featlock:start -->")) return false;
  const cleaned = existing.replace(/\n*<!-- featlock:start -->[\s\S]*?<!-- featlock:end -->\n*/g, "\n").trim();
  fs.writeFileSync(filePath, cleaned ? `${cleaned}\n` : "", "utf8");
  return true;
}

interface FileHookSpec {
  readonly id: string;
  readonly label: string;
  readonly relScript: string;
  readonly docRel: string;
  readonly binding?: HarnessConfigBinding;
}

function makeFileHookHarness(spec: FileHookSpec): HarnessSpec {
  if (!spec.id || !spec.relScript) throw new Error("Harness id and relScript are required.");
  const { id, label, relScript, docRel, binding } = spec;
  return {
    id,
    label,
    install: (repoRoot) => {
      const touched: string[] = [];
      const absHook = path.join(repoRoot, relScript);
      fs.mkdirSync(path.dirname(absHook), { recursive: true });
      fs.writeFileSync(absHook, HOOK_SCRIPT_CONTENT, { encoding: "utf8", mode: 0o755 });
      touched.push(relScript);
      if (binding && wireJsonHookConfig(repoRoot, binding, relScript)) touched.push(binding.configRel);
      if (ensureAgentRule(path.join(repoRoot, docRel))) touched.push(docRel);
      return touched;
    },
    uninstall: (repoRoot) => {
      const touched: string[] = [];
      const absHook = path.join(repoRoot, relScript);
      if (fs.existsSync(absHook)) {
        fs.rmSync(absHook, { force: true });
        touched.push(relScript);
      }
      if (binding && unwireJsonHookConfig(repoRoot, binding, relScript)) touched.push(binding.configRel);
      if (removeAgentRule(path.join(repoRoot, docRel))) touched.push(docRel);
      return touched;
    },
    status: async (repoRoot) => {
      const scriptExists = fs.existsSync(path.join(repoRoot, relScript));
      const wired = binding ? isJsonHookWired(repoRoot, binding, relScript) : true;
      const installed = scriptExists && wired;
      const detail = installed
        ? binding
          ? `active (${relScript} + ${binding.configRel})`
          : `active (${relScript})`
        : scriptExists
          ? `unwired (${relScript} missing registration in ${binding?.configRel ?? "config"})`
          : `not installed (${relScript})`;
      return { installed, detail };
    },
  };
}

const BUILTIN_HARNESS_SPECS: readonly FileHookSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    relScript: ".claude/hooks/feature-guard.mjs",
    docRel: "AGENTS.md",
    binding: { configRel: ".claude/settings.local.json", eventKey: "Stop", format: "nested" },
  },
  {
    id: "codex",
    label: "Codex CLI",
    relScript: ".codex/hooks/feature-guard.mjs",
    docRel: "AGENTS.md",
    binding: { configRel: ".codex/hooks.json", eventKey: "Stop", format: "nested" },
  },
  {
    id: "cursor",
    label: "Cursor",
    relScript: ".cursor/hooks/feature-guard.mjs",
    docRel: "AGENTS.md",
    binding: { configRel: ".cursor/hooks.json", eventKey: "stop", format: "flat" },
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    relScript: ".github/hooks/feature-guard.mjs",
    docRel: ".github/copilot-instructions.md",
  },
];

export default Plugin.define({
  id: "featlock.harnesses",
  async setup(ctx) {
    await ctx.harness.transform((ed) => {
      for (const spec of BUILTIN_HARNESS_SPECS) ed.add(makeFileHookHarness(spec));
    });
  },
});
