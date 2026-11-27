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
  type ReporterSpec,
} from "@featlock/plugin";
import { Registry, REGISTRY_SQL_REL } from "../db/registry.ts";
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

interface CheckHookItem {
  readonly id: string;
  readonly name: "beforeCheck" | "afterCheck";
  readonly handler: (event: CheckHookEvent) => void | Promise<void>;
}

interface HostDomains {
  readonly extractors: ReturnType<typeof State.createKeyedDomain<ExtractorSpec>>;
  readonly scanners: ReturnType<typeof State.createKeyedDomain<InvariantScannerSpec>>;
  readonly guards: ReturnType<typeof State.createKeyedDomain<GuardSpec>>;
  readonly passes: ReturnType<typeof State.createKeyedDomain<AgentPassSpec>>;
  readonly harnesses: ReturnType<typeof State.createKeyedDomain<HarnessSpec>>;
  readonly reporters: ReturnType<typeof State.createKeyedDomain<ReporterSpec>>;
  readonly commands: ReturnType<typeof State.createKeyedDomain<CommandSpec>>;
  readonly checkHooks: ReturnType<typeof State.createKeyedDomain<CheckHookItem>>;
  readonly slots: Map<string, ActiveSlot>;
  hookSeq: number;
}

function createHostDomains(): HostDomains {
  return {
    extractors: State.createKeyedDomain<ExtractorSpec>("extractor"),
    scanners: State.createKeyedDomain<InvariantScannerSpec>("invariantScanner"),
    guards: State.createKeyedDomain<GuardSpec>("guard"),
    passes: State.createKeyedDomain<AgentPassSpec>("agentPass"),
    harnesses: State.createKeyedDomain<HarnessSpec>("harness"),
    reporters: State.createKeyedDomain<ReporterSpec>("reporter"),
    commands: State.createKeyedDomain<CommandSpec>("command"),
    checkHooks: State.createKeyedDomain<CheckHookItem>("checkHook"),
    slots: new Map<string, ActiveSlot>(),
    hookSeq: 0,
  };
}

function matchesSelector(selector: string, id: string): boolean {
  if (selector === "*") return true;
  if (selector.endsWith(".*")) return id.startsWith(selector.slice(0, -1));
  return selector === id;
}

async function resolveExternalPlugin(target: string): Promise<FeatlockPlugin> {
  if (!target) throw new Error("Plugin target path is required.");
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

async function disposeAllSlots(domains: HostDomains): Promise<void> {
  for (const slot of Array.from(domains.slots.values()).toReversed()) {
    await disposeSlot(slot);
  }
  domains.slots.clear();
}

function buildPluginContext(
  domains: HostDomains,
  opts: PluginHostOptions,
  plugin: FeatlockPlugin,
  cleanups: Array<() => Promise<void> | void>,
): FeatlockPluginContext {
  return {
    options: opts.optionsByPlugin?.[plugin.id] ?? {},
    extractor: makeDomainHandle(domains.extractors, cleanups),
    invariantScanner: makeDomainHandle(domains.scanners, cleanups),
    guard: makeDomainHandle(domains.guards, cleanups),
    agentPass: makeDomainHandle(domains.passes, cleanups),
    harness: makeDomainHandle(domains.harnesses, cleanups),
    reporter: makeDomainHandle(domains.reporters, cleanups),
    command: makeDomainHandle(domains.commands, cleanups),
    check: {
      hook: async (name, handler): Promise<PluginRegistration> => {
        const id = `${plugin.id}:hook:${++domains.hookSeq}`;
        const reg = domains.checkHooks.transform((ed) => ed.add({ id, name, handler }));
        cleanups.push(reg.dispose);
        return reg;
      },
    },
  };
}

async function mountPluginSlot(
  domains: HostDomains,
  opts: PluginHostOptions,
  plugin: FeatlockPlugin,
  source: PluginStatus["source"],
): Promise<void> {
  if (!plugin.id) throw new Error("Plugin id is required.");
  const guarded = plugin.guarded === true || GUARDED_PLUGIN_IDS.has(plugin.id);
  const cleanups: Array<() => Promise<void> | void> = [];
  const slot: ActiveSlot = { id: plugin.id, source, guarded, cleanups, lifecycle: { status: "active", group: null } };
  domains.slots.set(plugin.id, slot);
  const ctx = buildPluginContext(domains, opts, plugin, cleanups);

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
    if (slot.lifecycle.status === "active") slot.lifecycle = { status: "active", group };
    domains.extractors.get();
    domains.scanners.get();
    domains.guards.get();
    domains.passes.get();
    domains.harnesses.get();
    domains.reporters.get();
    domains.commands.get();
    domains.checkHooks.get();
  } catch (err) {
    slot.lifecycle = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    await disposeSlot(slot);
  }
}

async function activatePlugins(
  domains: HostDomains,
  opts: PluginHostOptions,
  extraPlugins: readonly unknown[],
  operations: readonly PluginOperation[],
): Promise<void> {
  if (!domains) throw new Error("HostDomains instance is required.");
  await disposeAllSlots(domains);
  const builtins = opts.includeBuiltins === false ? { pre: [], post: [] } : getBuiltinPlugins();
  const entries: Array<{ plugin: FeatlockPlugin; source: PluginStatus["source"] }> = [
    ...builtins.pre.map((plugin) => ({ plugin, source: "builtin" as const })),
    ...extraPlugins.filter(isFeatlockPlugin).map((plugin) => ({ plugin, source: "inline" as const })),
  ];

  for (const op of operations) {
    if (op.type !== "add" || entries.some((e) => e.plugin.id === op.target)) continue;
    try {
      entries.push({ plugin: await resolveExternalPlugin(op.target), source: "package" });
    } catch (err) {
      domains.slots.set(op.target, {
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
  for (const entry of activeEntries) await mountPluginSlot(domains, opts, entry.plugin, entry.source);
}

async function runExtract(domains: HostDomains, repoDir: string): Promise<ExtractionOutput> {
  const scanCtx = discoverRepo(repoDir);
  const featuresMap = new Map<string, FeatureRecord>();
  const testsMap = new Map<string, FeatureTestLink>();
  const invariantsMap = new Map<string, InvariantRecord>();

  for (const ext of domains.extractors.get()) {
    const out = await ext.extract(scanCtx);
    for (const f of out.features) featuresMap.set(f.id, f);
    for (const t of out.tests) testsMap.set(`${t.featureId}|${t.testPath}|${t.testPattern}`, t);
    for (const inv of out.invariants) invariantsMap.set(inv.id, inv);
  }
  for (const scanner of domains.scanners.get()) {
    for (const inv of await scanner.scan(scanCtx)) invariantsMap.set(inv.id, inv);
  }
  return {
    features: Array.from(featuresMap.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    tests: Array.from(testsMap.values()),
    invariants: Array.from(invariantsMap.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

async function runCheck(
  domains: HostDomains,
  repoDir: string,
  checkOpts?: { readonly allowRemoval?: boolean },
): Promise<CheckResult> {
  if (!repoDir) throw new Error("repoDir is required for featlock check.");
  const scanCtx = discoverRepo(repoDir);
  const registry = Registry.readRepo(scanCtx.repoRoot);
  const ctx: CheckContext = {
    repoRoot: scanCtx.repoRoot,
    registryPath: path.join(scanCtx.repoRoot, REGISTRY_SQL_REL),
    registry,
    previousRegistry: Registry.readHead(scanCtx.repoRoot),
    stagedFiles: listStagedFiles(scanCtx.repoRoot),
    allowRemoval: checkOpts?.allowRemoval ?? (process.env.ALLOW_FEATURE_REMOVAL === "1"),
    files: scanCtx.files,
  };

  const violations: GuardViolation[] = [];
  const beforeEvent: CheckHookEvent = { repoRoot: scanCtx.repoRoot, violations };
  for (const h of domains.checkHooks.get().filter((x) => x.name === "beforeCheck")) await h.handler(beforeEvent);
  for (const guard of domains.guards.get()) violations.push(...(await guard.evaluate(ctx)));
  const afterEvent: CheckHookEvent = { repoRoot: scanCtx.repoRoot, violations };
  for (const h of domains.checkHooks.get().filter((x) => x.name === "afterCheck")) await h.handler(afterEvent);

  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warn");
  return { ok: errors.length === 0, violations: errors, warnings, counts: Registry.count(registry) };
}

async function runBuildAgentPasses(domains: HostDomains, repoDir: string): Promise<readonly AgentPassPacket[]> {
  const scanCtx = discoverRepo(repoDir);
  const registry = Registry.readRepo(scanCtx.repoRoot);
  const packets: AgentPassPacket[] = [];
  for (const p of domains.passes.get().toSorted((a, b) => a.order - b.order)) {
    packets.push(await p.buildPacket(scanCtx, registry));
  }
  return packets;
}

async function runCliCommand(
  domains: HostDomains,
  facade: HostApiFacade,
  argv: readonly string[],
  repoRoot: string,
): Promise<number> {
  const cmdName = argv[0];
  if (!cmdName || cmdName === "-h" || cmdName === "--help") {
    console.log("featlock — Tight-core SQLite feature, test & invariant guard\n");
    for (const cmd of domains.commands.get()) console.log(`  featlock ${cmd.id.padEnd(20)} ${cmd.description}`);
    return 0;
  }
  const found = domains.commands.get().find((c) => c.id === cmdName);
  if (!found) {
    console.error(`Unknown featlock command: ${cmdName}`);
    return 2;
  }
  const rest = argv.slice(1);
  return await found.run({ repoRoot: path.resolve(repoRoot), args: rest, asJson: rest.includes("--json"), host: facade });
}

export async function createPluginHost(opts: PluginHostOptions = {}): Promise<PluginHostInstance> {
  if (!opts) throw new Error("PluginHostOptions must be defined.");
  const domains = createHostDomains();
  const list = (): readonly PluginStatus[] =>
    Array.from(domains.slots.values()).map((s) => ({
      id: s.id,
      source: s.source,
      state: s.lifecycle.status === "active" ? { status: "active" } : { status: "failed", error: s.lifecycle.error },
      guarded: s.guarded,
    }));

  const facade: HostApiFacade = {
    listPlugins: list,
    extract: (repoDir) => runExtract(domains, repoDir),
    check: (repoDir, checkOpts) => runCheck(domains, repoDir, checkOpts),
    sync: async (repoDir) => {
      const out = Registry.materializeDb(path.resolve(repoDir));
      return { sqlPath: out.sqlPath, dbPath: out.dbPath, counts: out.counts };
    },
    query: async (repoDir, term) => Registry.queryFeatures(Registry.readRepo(path.resolve(repoDir)), term),
    checkDup: async (repoDir, description) => Registry.findDuplicates(Registry.readRepo(path.resolve(repoDir)), description),
    recordNew: async (input) => Registry.recordNew({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    recordImprovement: async (input) => Registry.recordImprovement({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    writeRegistry: async (repoDir, snapshot) => {
      const sqlPath = Registry.writeSql(path.resolve(repoDir), snapshot);
      Registry.materializeDb(path.resolve(repoDir));
      return sqlPath;
    },
    readRegistry: async (repoDir) => Registry.readRepo(path.resolve(repoDir)),
    buildAgentPasses: (repoDir) => runBuildAgentPasses(domains, repoDir),
    getHarnesses: () => domains.harnesses.get(),
    getCommands: () => domains.commands.get(),
    getReporters: () => domains.reporters.get(),
  };

  await activatePlugins(domains, opts, opts.plugins ?? [], opts.operations ?? []);
  return {
    ...facade,
    list,
    activate: (extraPlugins, operations = []) => activatePlugins(domains, opts, extraPlugins, operations),
    dispose: () => disposeAllSlots(domains),
    runCli: (argv, repoRoot = process.cwd()) => runCliCommand(domains, facade, argv, repoRoot),
  };
}

export const PluginHost = {
  create: createPluginHost,
};
