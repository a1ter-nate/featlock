import fs from "node:fs";
import path from "node:path";
import { Plugin, type HarnessSpec } from "@featlock/plugin";

const HOOK_SCRIPT_CONTENT = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const res = spawnSync("featlock", ["check", "."], { encoding: "utf8" });
if (res.status !== 0) {
  process.stderr.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
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

function makeFileHookHarness(id: string, label: string, relScript: string, docRel: string): HarnessSpec {
  return {
    id,
    label,
    install: (repoRoot) => {
      const touched: string[] = [];
      const absHook = path.join(repoRoot, relScript);
      fs.mkdirSync(path.dirname(absHook), { recursive: true });
      fs.writeFileSync(absHook, HOOK_SCRIPT_CONTENT, { encoding: "utf8", mode: 0o755 });
      touched.push(relScript);
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
      if (removeAgentRule(path.join(repoRoot, docRel))) touched.push(docRel);
      return touched;
    },
    status: async (repoRoot) => {
      const exists = fs.existsSync(path.join(repoRoot, relScript));
      return { installed: exists, detail: exists ? `active (${relScript})` : `not installed (${relScript})` };
    },
  };
}

export default Plugin.define({
  id: "featlock.harnesses",
  async setup(ctx) {
    await ctx.harness.transform((ed) => {
      ed.add(makeFileHookHarness("claude", "Claude Code", ".claude/hooks/feature-guard.mjs", "AGENTS.md"));
      ed.add(makeFileHookHarness("codex", "Codex CLI", ".codex/hooks/feature-guard.mjs", "AGENTS.md"));
      ed.add(makeFileHookHarness("cursor", "Cursor", ".cursor/hooks/feature-guard.mjs", "AGENTS.md"));
      ed.add(makeFileHookHarness("copilot", "GitHub Copilot", ".github/hooks/feature-guard.mjs", ".github/copilot-instructions.md"));
    });
  },
});
