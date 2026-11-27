#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { createPluginHost, type PluginOperation } from "@featlock/core";

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

const args = process.argv.slice(2);
const extraOps: PluginOperation[] = [];
const cleanedArgs: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const cur = args[i] ?? "";
  if (cur === "--plugin" && args[i + 1]) {
    extraOps.push({ type: "add", target: args[i + 1] ?? "" });
    i += 1;
  } else if (cur === "--remove-plugin" && args[i + 1]) {
    extraOps.push({ type: "remove", target: args[i + 1] ?? "" });
    i += 1;
  } else {
    cleanedArgs.push(cur);
  }
}

const targetArg = cleanedArgs.find((a, idx) => idx > 0 && !a.startsWith("-"));
const repoDir = targetArg && fs.existsSync(targetArg) && fs.statSync(targetArg).isDirectory()
  ? path.resolve(targetArg)
  : process.cwd();

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
