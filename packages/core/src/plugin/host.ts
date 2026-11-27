import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isFeatlockPlugin,
  type AgentPassPacket,
  type AgentPassSpec,
  type CheckContext,
  type CheckHookEvent,
  type CheckResult,
  type CommandSpec,
  type DomainTransformHandle,
  type DuplicateCandidate,
  type ExtractionOutput,
  type ExtractorSpec,
  type FeatlockPlugin,
  type FeatlockPluginContext,
  type FeatureRecord,
  type FeatureTestLink,
  type GuardSpec,
  type GuardViolation,
  type HarnessSpec,
  type HostApiFacade,
  type InvariantRecord,
  type InvariantScannerSpec,
  type PluginRegistration,
  type PluginStatus,
  type RegistryCounts,
  type ReporterSpec,
} from "@featlock/plugin";
import {
  countRegistry,
  findDuplicateFeatures,
  materializeRegistryDb,
  queryRegistryFeatures,
  readHeadRegistry,
  readRepoRegistry,
  recordFeatureImprovement,
  recordNewFeature,
  REGISTRY_SQL_REL,
  writeRegistrySql,
} from "../db/registry.ts";
import { discoverRepo, listStagedFiles } from "../discover.ts";
import { State, type RegistrationGroup } from "../state.ts";
import { getBuiltinPlugins, GUARDED_PLUGIN_IDS } from "./internal.ts";

export interface PluginOperation {
  readonly type: "add" | "remove";
  readonly target: string;
}

export interface PluginHostOptions {
  readonly repoDir?: string;
  readonly plugins?: readonly unknown[];
  readonly operations?: readonly PluginOperation[];
  readonly includeBuiltins?: boolean;
  readonly optionsByPlugin?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface PluginHostInstance extends HostApiFacade {
  readonly list: () => readonly PluginStatus[];
  readonly activate: (plugins: readonly unknown[], operations?: readonly PluginOperation[]) => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly runCli: (argv: readonly string[], repoRoot?: string) => Promise<number>;
}

type SlotLifecycle =
  | { readonly status: "active"; readonly group: RegistrationGroup | null }
  | { readonly status: "failed"; readonly error: string };

interface ActiveSlot {
  readonly id: string;
  readonly source: PluginStatus["source"];
  readonly guarded: boolean;
  readonly cleanups: Array<() => Promise<void> | void>;
  lifecycle: SlotLifecycle;
}

function matchesSelector(selector: string, id: string): boolean {
  if (selector === "*") return true;
  if (selector.endsWith(".*")) return id.startsWith(selector.slice(0, -1));
  return selector === id;
}

async function resolveExternalPlugin(target: string): Promise<FeatlockPlugin> {
  const abs = path.resolve(target);
  let entryFile = abs;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const pkgFile = path.join(abs, "package.json");
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as {
        exports?: string | Record<string, string | { default?: string; import?: string }>;
        main?: string;
      };
      const dotExport = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
      const relEntry =
        typeof dotExport === "string"
          ? dotExport
          : typeof dotExport === "object" && dotExport !== null
            ? (dotExport.import ?? dotExport.default ?? pkg.main ?? "index.ts")
            : (pkg.main ?? "index.ts");
      entryFile = path.resolve(abs, relEntry);
    } else {
      entryFile = path.join(abs, "index.ts");
    }
  }
  const mod = (await import(pathToFileURL(entryFile).href)) as { default?: unknown; plugin?: unknown };
  const candidate = mod.default ?? mod.plugin;
  if (!isFeatlockPlugin(candidate)) {
    throw new Error(`Module '${target}' did not export a valid FeatLock plugin.`);
  }
  return candidate;
}

function makeDomainHandle<TItem extends { readonly id: string }>(
  state: ReturnType<typeof State.createKeyedDomain<TItem>>,
  cleanups: Array<() => Promise<void> | void>,
): DomainTransformHandle<TItem> {
  return {
    transform: async (cb) => {
      const reg = state.transform(cb);
      cleanups.push(reg.dispose);
      return reg;
    },
    reload: async () => {
      state.reload();
    },
  };
}

async function syncRepo(
  repoDir: string,
): Promise<{ readonly sqlPath: string; readonly dbPath: string; readonly counts: RegistryCounts }> {
  const out = materializeRegistryDb(path.resolve(repoDir));
  return { sqlPath: out.sqlPath, dbPath: out.dbPath, counts: out.counts };
}

async function queryRepo(repoDir: string, term: string): Promise<readonly FeatureRecord[]> {
  return queryRegistryFeatures(readRepoRegistry(path.resolve(repoDir)), term);
}

async function checkDupRepo(repoDir: string, description: string): Promise<readonly DuplicateCandidate[]> {
  return findDuplicateFeatures(readRepoRegistry(path.resolve(repoDir)), description);
}

async function disposeSlot(slot: ActiveSlot): Promise<void> {
  for (const cleanup of slot.cleanups.toReversed()) {
    try {
      await cleanup();
    } catch {
      continue;
    }
  }
  slot.cleanups.length = 0;
}

export async function createPluginHost(opts: PluginHostOptions = {}): Promise<PluginHostInstance> {
  const extractors = State.createKeyedDomain<ExtractorSpec>("extractor");
  const scanners = State.createKeyedDomain<InvariantScannerSpec>("invariantScanner");
  const guards = State.createKeyedDomain<GuardSpec>("guard");
  const passes = State.createKeyedDomain<AgentPassSpec>("agentPass");
  const harnesses = State.createKeyedDomain<HarnessSpec>("harness");
  const reporters = State.createKeyedDomain<ReporterSpec>("reporter");
  const commands = State.createKeyedDomain<CommandSpec>("command");
  const checkHooks = State.createKeyedDomain<{
    readonly id: string;
    readonly name: "beforeCheck" | "afterCheck";
    readonly handler: (event: CheckHookEvent) => void | Promise<void>;
  }>("checkHook");

  const slots = new Map<string, ActiveSlot>();
  let hookSeq = 0;

  const disposeAll = async (): Promise<void> => {
    for (const slot of Array.from(slots.values()).toReversed()) {
      await disposeSlot(slot);
    }
    slots.clear();
  };

  const mountPlugin = async (plugin: FeatlockPlugin, source: PluginStatus["source"]): Promise<void> => {
    const guarded = plugin.guarded === true || GUARDED_PLUGIN_IDS.has(plugin.id);
    const cleanups: Array<() => Promise<void> | void> = [];
    const slot: ActiveSlot = {
      id: plugin.id,
      source,
      guarded,
      cleanups,
      lifecycle: { status: "active", group: null },
    };
    slots.set(plugin.id, slot);

    const ctx: FeatlockPluginContext = {
      options: opts.optionsByPlugin?.[plugin.id] ?? {},
      extractor: makeDomainHandle(extractors, cleanups),
      invariantScanner: makeDomainHandle(scanners, cleanups),
      guard: makeDomainHandle(guards, cleanups),
      agentPass: makeDomainHandle(passes, cleanups),
      harness: makeDomainHandle(harnesses, cleanups),
      reporter: makeDomainHandle(reporters, cleanups),
      command: makeDomainHandle(commands, cleanups),
      check: {
        hook: async (name, handler): Promise<PluginRegistration> => {
          const id = `${plugin.id}:hook:${++hookSeq}`;
          const reg = checkHooks.transform((ed) => ed.add({ id, name, handler }));
          cleanups.push(reg.dispose);
          return reg;
        },
      },
    };

    try {
      const { group, result } = await State.groupAsync(
        (failure) => {
          slot.lifecycle = {
            status: "failed",
            error: failure.cause instanceof Error ? failure.cause.message : String(failure.cause),
          };
        },
        async () => await plugin.setup(ctx),
      );
      if (typeof result === "function") cleanups.push(result);
      if (slot.lifecycle.status === "active") {
        slot.lifecycle = { status: "active", group };
      }
      extractors.get();
      scanners.get();
      guards.get();
      passes.get();
      harnesses.get();
      reporters.get();
      commands.get();
      checkHooks.get();
    } catch (err) {
      slot.lifecycle = { status: "failed", error: err instanceof Error ? err.message : String(err) };
      await disposeSlot(slot);
    }
  };

  const activate = async (
    extraPlugins: readonly unknown[],
    operations: readonly PluginOperation[] = [],
  ): Promise<void> => {
    await disposeAll();
    const builtins = opts.includeBuiltins === false ? { pre: [], post: [] } : getBuiltinPlugins();
    const entries: Array<{ plugin: FeatlockPlugin; source: PluginStatus["source"] }> = [
      ...builtins.pre.map((plugin) => ({ plugin, source: "builtin" as const })),
      ...extraPlugins.filter(isFeatlockPlugin).map((plugin) => ({ plugin, source: "inline" as const })),
    ];

    for (const op of operations) {
      if (op.type !== "add") continue;
      if (entries.some((e) => e.plugin.id === op.target)) continue;
      try {
        const loaded = await resolveExternalPlugin(op.target);
        entries.push({ plugin: loaded, source: "package" });
      } catch (err) {
        slots.set(op.target, {
          id: op.target,
          source: "package",
          guarded: false,
          cleanups: [],
          lifecycle: { status: "failed", error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    entries.push(...builtins.post.map((plugin) => ({ plugin, source: "builtin" as const })));
    const removedSelectors = operations.filter((o) => o.type === "remove").map((o) => o.target);
    const activeEntries = entries.filter((entry) => {
      const isGuarded = entry.plugin.guarded === true || GUARDED_PLUGIN_IDS.has(entry.plugin.id);
      if (isGuarded) return true;
      return !removedSelectors.some((sel) => matchesSelector(sel, entry.plugin.id));
    });

    for (const entry of activeEntries) {
      await mountPlugin(entry.plugin, entry.source);
    }
  };

  const list = (): readonly PluginStatus[] =>
    Array.from(slots.values()).map((s) => ({
      id: s.id,
      source: s.source,
      state:
        s.lifecycle.status === "active"
          ? { status: "active" }
          : { status: "failed", error: s.lifecycle.error },
      guarded: s.guarded,
    }));

  const extract = async (repoDir: string): Promise<ExtractionOutput> => {
    const scanCtx = discoverRepo(repoDir);
    const featuresMap = new Map<string, FeatureRecord>();
    const testsMap = new Map<string, FeatureTestLink>();
    const invariantsMap = new Map<string, InvariantRecord>();

    for (const ext of extractors.get()) {
      const out = await ext.extract(scanCtx);
      for (const f of out.features) featuresMap.set(f.id, f);
      for (const t of out.tests) testsMap.set(`${t.featureId}|${t.testPath}|${t.testPattern}`, t);
      for (const inv of out.invariants) invariantsMap.set(inv.id, inv);
    }
    for (const scanner of scanners.get()) {
      const found = await scanner.scan(scanCtx);
      for (const inv of found) invariantsMap.set(inv.id, inv);
    }
    return {
      features: Array.from(featuresMap.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
      tests: Array.from(testsMap.values()),
      invariants: Array.from(invariantsMap.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    };
  };

  const check = async (
    repoDir: string,
    checkOpts?: { readonly allowRemoval?: boolean },
  ): Promise<CheckResult> => {
    const scanCtx = discoverRepo(repoDir);
    const registry = readRepoRegistry(scanCtx.repoRoot);
    const previousRegistry = readHeadRegistry(scanCtx.repoRoot);
    const ctx: CheckContext = {
      repoRoot: scanCtx.repoRoot,
      registryPath: path.join(scanCtx.repoRoot, REGISTRY_SQL_REL),
      registry,
      previousRegistry,
      stagedFiles: listStagedFiles(scanCtx.repoRoot),
      allowRemoval: checkOpts?.allowRemoval === true || process.env.ALLOW_FEATURE_REMOVAL === "1",
      files: scanCtx.files,
    };

    const violations: GuardViolation[] = [];
    const beforeEvent: CheckHookEvent = { repoRoot: scanCtx.repoRoot, violations };
    for (const h of checkHooks.get().filter((x) => x.name === "beforeCheck")) await h.handler(beforeEvent);
    for (const guard of guards.get()) {
      violations.push(...(await guard.evaluate(ctx)));
    }
    const afterEvent: CheckHookEvent = { repoRoot: scanCtx.repoRoot, violations };
    for (const h of checkHooks.get().filter((x) => x.name === "afterCheck")) await h.handler(afterEvent);

    const errors = violations.filter((v) => v.severity === "error");
    const warnings = violations.filter((v) => v.severity === "warn");
    return { ok: errors.length === 0, violations: errors, warnings, counts: countRegistry(registry) };
  };

  const buildAgentPasses = async (repoDir: string): Promise<readonly AgentPassPacket[]> => {
    const scanCtx = discoverRepo(repoDir);
    const registry = readRepoRegistry(scanCtx.repoRoot);
    const ordered = passes.get().toSorted((a, b) => a.order - b.order);
    const packets: AgentPassPacket[] = [];
    for (const p of ordered) {
      packets.push(await p.buildPacket(scanCtx, registry));
    }
    return packets;
  };

  const facade: HostApiFacade = {
    listPlugins: list,
    extract,
    check,
    sync: syncRepo,
    query: queryRepo,
    checkDup: checkDupRepo,
    recordNew: async (input) => recordNewFeature({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    recordImprovement: async (input) => recordFeatureImprovement({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    writeRegistry: async (repoDir, snapshot) => {
      const sqlPath = writeRegistrySql(path.resolve(repoDir), snapshot);
      materializeRegistryDb(path.resolve(repoDir));
      return sqlPath;
    },
    readRegistry: async (repoDir) => readRepoRegistry(path.resolve(repoDir)),
    buildAgentPasses,
    getHarnesses: () => harnesses.get(),
    getCommands: () => commands.get(),
    getReporters: () => reporters.get(),
  };

  const runCli = async (argv: readonly string[], repoRoot = process.cwd()): Promise<number> => {
    const cmdName = argv[0];
    if (!cmdName || cmdName === "-h" || cmdName === "--help") {
      console.log("featlock — Tight-core SQLite feature, test & invariant guard\n");
      for (const cmd of commands.get()) {
        console.log(`  featlock ${cmd.id.padEnd(20)} ${cmd.description}`);
      }
      return 0;
    }
    const found = commands.get().find((c) => c.id === cmdName);
    if (!found) {
      console.error(`Unknown featlock command: ${cmdName}`);
      return 2;
    }
    const rest = argv.slice(1);
    return await found.run({
      repoRoot: path.resolve(repoRoot),
      args: rest,
      asJson: rest.includes("--json"),
      host: facade,
    });
  };

  await activate(opts.plugins ?? [], opts.operations ?? []);

  return {
    ...facade,
    list,
    activate,
    dispose: disposeAll,
    runCli,
  };
}

export const PluginHost = {
  create: createPluginHost,
};
