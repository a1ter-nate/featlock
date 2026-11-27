import { Plugin, type CommandRunContext, type RegistrySnapshot } from "@featlock/plugin";

function parseFlag(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i] ?? "";
    if (cur === flag) return args[i + 1];
    if (cur.startsWith(`${flag}=`)) return cur.slice(flag.length + 1);
  }
  return undefined;
}

function mergeExtraction(existing: RegistrySnapshot, extracted: {
  readonly features: RegistrySnapshot["features"];
  readonly tests: RegistrySnapshot["tests"];
  readonly invariants: RegistrySnapshot["invariants"];
}): RegistrySnapshot {
  if (!existing || !extracted) throw new Error("Existing and extracted snapshots are required.");
  const fMap = new Map(existing.features.map((f) => [f.id, f]));
  for (const f of extracted.features) {
    if (!fMap.has(f.id)) fMap.set(f.id, f);
  }
  const tMap = new Map(existing.tests.map((t) => [`${t.featureId}|${t.testPath}|${t.testPattern}`, t]));
  for (const t of extracted.tests) {
    if (!fMap.has(t.featureId)) continue;
    tMap.set(`${t.featureId}|${t.testPath}|${t.testPattern}`, t);
  }
  const iMap = new Map(existing.invariants.map((i) => [i.id, i]));
  for (const inv of extracted.invariants) {
    const featureId = fMap.has(inv.featureId) ? inv.featureId : (extracted.features[0]?.id ?? existing.features[0]?.id);
    if (!featureId) continue;
    if (!iMap.has(inv.id)) iMap.set(inv.id, { ...inv, featureId });
  }
  return {
    features: [...fMap.values()],
    tests: [...tMap.values()],
    invariants: [...iMap.values()],
    auditLog: [
      ...existing.auditLog,
      {
        featureId: "registry",
        action: "added",
        actor: "featlock-extract",
        summary: `Extracted ${extracted.features.length} feature(s), ${extracted.tests.length} test link(s), ${extracted.invariants.length} invariant(s).`,
      },
    ],
  };
}

async function runExtract(ctx: CommandRunContext): Promise<number> {
  const extracted = await ctx.host.extract(ctx.repoRoot);
  const shouldWrite = ctx.args.includes("--write");
  if (shouldWrite) {
    const existing = await ctx.host.readRegistry(ctx.repoRoot);
    const merged = mergeExtraction(existing, extracted);
    const sqlPath = await ctx.host.writeRegistry(ctx.repoRoot, merged);
    if (ctx.asJson) {
      console.log(JSON.stringify({ sqlPath, extracted, total: { features: merged.features.length, tests: merged.tests.length, invariants: merged.invariants.length } }, null, 2));
    } else {
      console.log(`Wrote ${sqlPath}: ${merged.features.length} features, ${merged.tests.length} tests, ${merged.invariants.length} invariants.`);
    }
    return 0;
  }
  if (ctx.asJson) {
    console.log(JSON.stringify(extracted, null, 2));
  } else {
    console.log(`Extracted ${extracted.features.length} feature(s), ${extracted.tests.length} test link(s), ${extracted.invariants.length} invariant(s).`);
    for (const f of extracted.features.slice(0, 20)) console.log(`  - [${f.source}] ${f.id}: ${f.name}`);
  }
  return 0;
}

async function runCheck(ctx: CommandRunContext): Promise<number> {
  const res = await ctx.host.check(
    ctx.repoRoot,
    ctx.args.includes("--allow-removal") ? { allowRemoval: true } : undefined,
  );
  if (ctx.asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`featlock check [${res.ok ? "PASS" : "FAIL"}]: ${res.counts.features} features, ${res.counts.tests} tests, ${res.counts.invariants} invariants | ${res.violations.length} error(s), ${res.warnings.length} warning(s)`);
    for (const v of res.violations) console.error(`  [ERROR] ${v.rule}: ${v.message}`);
    for (const w of res.warnings) console.warn(`  [WARN]  ${w.rule}: ${w.message}`);
  }
  return res.ok ? 0 : 1;
}

async function runRecordNew(ctx: CommandRunContext): Promise<number> {
  const id = parseFlag(ctx.args, "--id");
  const area = parseFlag(ctx.args, "--area") ?? "core";
  const name = parseFlag(ctx.args, "--name") ?? id ?? "";
  const summary = parseFlag(ctx.args, "--summary") ?? name;
  const criteria = parseFlag(ctx.args, "--criteria") ?? `Verified by linked tests for ${name}.`;
  const testPath = parseFlag(ctx.args, "--test");
  const pattern = parseFlag(ctx.args, "--pattern") ?? name;
  const rung = parseFlag(ctx.args, "--rung") ?? "R2";
  if (!id || !testPath) {
    console.error("Usage: featlock record-new --id <id> --name <name> --area <area> --summary <summary> --test <testPath>");
    return 2;
  }
  const snap = await ctx.host.recordNew({
    repoRoot: ctx.repoRoot,
    feature: { id, area, name, summary, acceptanceCriteria: criteria, status: "active", source: "manual" },
    tests: [{ featureId: id, testPath, testPattern: pattern, rung }],
  });
  console.log(ctx.asJson ? JSON.stringify({ recorded: id, totalFeatures: snap.features.length }, null, 2) : `Recorded new feature '${id}' with test '${testPath}'.`);
  return 0;
}

async function runRecordImprovement(ctx: CommandRunContext): Promise<number> {
  const id = parseFlag(ctx.args, "--id");
  const summary = parseFlag(ctx.args, "--summary");
  const testPath = parseFlag(ctx.args, "--test");
  const pattern = parseFlag(ctx.args, "--pattern") ?? summary ?? "improvement";
  const rung = parseFlag(ctx.args, "--rung") ?? "R2";
  if (!id || !summary) {
    console.error("Usage: featlock record-improvement --id <featureId> --summary <summary> [--test <testPath>]");
    return 2;
  }
  const extraTests = testPath ? [{ featureId: id, testPath, testPattern: pattern, rung }] : [];
  await ctx.host.recordImprovement({ repoRoot: ctx.repoRoot, featureId: id, summary, extraTests });
  console.log(ctx.asJson ? JSON.stringify({ improved: id, summary }, null, 2) : `Logged improvement to '${id}': ${summary}`);
  return 0;
}

async function runHooks(ctx: CommandRunContext): Promise<number> {
  const action = ctx.args[0] ?? "status";
  const harnesses = ctx.host.getHarnesses();
  if (action === "on") {
    const installed: Record<string, readonly string[]> = {};
    for (const h of harnesses) installed[h.id] = await h.install(ctx.repoRoot);
    console.log(ctx.asJson ? JSON.stringify({ action: "on", installed }, null, 2) : `Installed FeatLock hooks for: ${harnesses.map((h) => h.id).join(", ")}`);
    return 0;
  }
  if (action === "off") {
    const removed: Record<string, readonly string[]> = {};
    for (const h of harnesses) removed[h.id] = await h.uninstall(ctx.repoRoot);
    console.log(ctx.asJson ? JSON.stringify({ action: "off", removed }, null, 2) : `Removed FeatLock hooks for: ${harnesses.map((h) => h.id).join(", ")}`);
    return 0;
  }
  const statuses: Array<{ id: string; installed: boolean; detail: string }> = [];
  for (const h of harnesses) {
    const st = await h.status(ctx.repoRoot);
    statuses.push({ id: h.id, ...st });
  }
  if (ctx.asJson) console.log(JSON.stringify({ harnesses: statuses }, null, 2));
  else for (const st of statuses) console.log(`  - ${st.id}: ${st.detail}`);
  return 0;
}

async function runSync(c: CommandRunContext): Promise<number> {
  const out = await c.host.sync(c.repoRoot);
  console.log(c.asJson ? JSON.stringify(out, null, 2) : `Synced ${out.dbPath} (${out.counts.features} features, ${out.counts.tests} tests, ${out.counts.invariants} invariants).`);
  return 0;
}

async function runQuery(c: CommandRunContext): Promise<number> {
  const term = c.args.filter((a) => !a.startsWith("-")).join(" ");
  const matches = await c.host.query(c.repoRoot, term);
  console.log(c.asJson ? JSON.stringify({ term, matches }, null, 2) : matches.map((m) => `${m.id} [${m.status}] ${m.name} — ${m.summary}`).join("\n") || "No matching features.");
  return 0;
}

async function runCheckDup(c: CommandRunContext): Promise<number> {
  const desc = c.args.filter((a) => !a.startsWith("-")).join(" ");
  const dups = await c.host.checkDup(c.repoRoot, desc);
  console.log(c.asJson ? JSON.stringify({ description: desc, duplicates: dups }, null, 2) : dups.map((d) => `${d.featureId} (score=${d.score}) — ${d.name} [${d.matchedTokens.join(", ")}]`).join("\n") || "No overlapping features detected.");
  return 0;
}

async function runAgentPass(c: CommandRunContext): Promise<number> {
  const packets = await c.host.buildAgentPasses(c.repoRoot);
  console.log(c.asJson ? JSON.stringify({ passes: packets }, null, 2) : packets.map((p) => `[${p.passId}] ${p.title} (${p.targets.length} targets)\n  ${p.objective}`).join("\n\n"));
  return 0;
}

async function runPluginsList(c: CommandRunContext): Promise<number> {
  const list = c.host.listPlugins();
  console.log(c.asJson ? JSON.stringify({ plugins: list }, null, 2) : list.map((p) => `${p.id} [${p.state.status}] (${p.source}${p.guarded ? ", guarded" : ""})`).join("\n"));
  return 0;
}

export default Plugin.define({
  id: "featlock.registry-cli",
  async setup(ctx) {
    await ctx.command.transform((ed) => {
      ed.add({ id: "extract", description: "Extract features, tests & invariants (AST + RepoSpec + Veristack) [--write]", run: runExtract });
      ed.add({ id: "check", description: "Verify feature coverage, invariant liveness & anti-deletion guards", run: runCheck });
      ed.add({ id: "sync", description: "Materialize .featlock/registry.sqlite from features/registry.sql", run: runSync });
      ed.add({ id: "query", description: "Search registered features by keyword", run: runQuery });
      ed.add({ id: "check-dup", description: "Check whether a proposed feature overlaps an existing registered feature", run: runCheckDup });
      ed.add({ id: "record-new", description: "Record a newly added feature + linked test in features/registry.sql", run: runRecordNew });
      ed.add({ id: "record-improvement", description: "Log an improvement to an existing feature in features/registry.sql", run: runRecordImprovement });
      ed.add({ id: "agent-pass", description: "Emit structured multi-pass AI agent investigation packets for invariant discovery", run: runAgentPass });
      ed.add({ id: "hooks", description: "Install, remove, or inspect coding agent guard hooks (on|off|status)", run: runHooks });
      ed.add({ id: "plugins", description: "List active and failed FeatLock plugins", run: runPluginsList });
    });
  },
});
