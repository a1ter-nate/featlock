import fs from "node:fs";
import path from "node:path";
import { createPluginHost, type PluginOperation } from "@featlock/core";

const REPO_SCOPED_COMMANDS = new Set(["extract", "check", "sync", "agent-pass", "hooks", "plugins", "matrix"]);

function loadRepoOperations(repoDir: string): PluginOperation[] {
  const cfgPath = path.join(repoDir, ".featlock", "config.json");
  if (!fs.existsSync(cfgPath)) return [];
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    plugins?: readonly string[];
    remove?: readonly string[];
  };
  const ops: PluginOperation[] = [];
  for (const p of raw.plugins ?? []) ops.push({ type: "add", target: path.isAbsolute(p) ? p : path.resolve(repoDir, p) });
  for (const r of raw.remove ?? []) ops.push({ type: "remove", target: r });
  return ops;
}

function parseCliArgs(rawArgs: readonly string[]): {
  readonly extraOps: PluginOperation[];
  readonly cleanedArgs: string[];
  readonly explicitRepo: string | null;
} {
  const extraOps: PluginOperation[] = [];
  const cleanedArgs: string[] = [];
  let explicitRepo: string | null = null;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const cur = rawArgs[i] ?? "";
    if (cur === "--plugin" && rawArgs[i + 1]) {
      extraOps.push({ type: "add", target: rawArgs[i + 1] ?? "" });
      i += 1;
    } else if (cur === "--remove-plugin" && rawArgs[i + 1]) {
      extraOps.push({ type: "remove", target: rawArgs[i + 1] ?? "" });
      i += 1;
    } else if ((cur === "--repo" || cur === "-C") && rawArgs[i + 1]) {
      explicitRepo = rawArgs[i + 1] ?? null;
      i += 1;
    } else if (cur.startsWith("--repo=")) {
      explicitRepo = cur.slice("--repo=".length);
    } else {
      cleanedArgs.push(cur);
    }
  }
  return { extraOps, cleanedArgs, explicitRepo };
}

function resolveTargetRepoDir(cleanedArgs: readonly string[], explicitRepo: string | null): string {
  if (explicitRepo) return path.resolve(explicitRepo);
  const cmd = cleanedArgs[0] ?? "";
  if (!REPO_SCOPED_COMMANDS.has(cmd)) return process.cwd();
  const targetArg = cleanedArgs.find((a, idx) => idx > 0 && !a.startsWith("-"));
  if (targetArg && fs.existsSync(targetArg) && fs.statSync(targetArg).isDirectory()) {
    return path.resolve(targetArg);
  }
  return process.cwd();
}

const { extraOps, cleanedArgs, explicitRepo } = parseCliArgs(process.argv.slice(2));
const repoDir = resolveTargetRepoDir(cleanedArgs, explicitRepo);

const host = await createPluginHost({
  repoDir,
  includeBuiltins: true,
  operations: [...loadRepoOperations(repoDir), ...extraOps],
});
try {
  process.exitCode = await host.runCli(cleanedArgs, repoDir);
} finally {
  await host.dispose();
}
