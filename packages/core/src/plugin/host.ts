import path from "node:path";
import type {
  AffectedTestsResult,
  AgentPassPacket,
  CheckContext,
  CheckHookEvent,
  CheckResult,
  ConcernSubgraphResult,
  ExtractionOutput,
  FeatlockStudioData,
  FeatureRecord,
  FeatureTestLink,
  FenceDistribution,
  GuardViolation,
  HostApiFacade,
  InvariantRecord,
  MatrixAnalysisResult,
  PluginStatus,
  RegistrySnapshot,
  RenderStudioOptions,
  StudioRenderContext,
  StudioTabSpec,
  StudioThemeTokens,
  StudioWidgetSpec,
} from "@featlock/plugin";
import { Registry, REGISTRY_SQL_REL } from "../db/registry.ts";
import { discoverRepo, listStagedFiles } from "../discover.ts";
import { createHostDomains, flushAllDomains, type HostDomains } from "./domains.ts";
import { createPluginSupervisor, type PluginOperation } from "./supervisor.ts";

export type { PluginOperation };

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

const EMPTY_MATRIX: MatrixAnalysisResult = {
  scattering: { dosByFeature: {}, dofByFile: {}, highScattering: [], highTangling: [] },
  interactions: [],
  flags: [],
};

function computeFenceDistribution(invariants: readonly InvariantRecord[]): FenceDistribution {
  const counts = { R0: 0, R1: 0, R2: 0, R3: 0, runtime: 0, none: 0, bugfixOrigin: 0, superseded: 0 };
  for (const inv of invariants) {
    if (inv.status === "removed") continue;
    if (inv.supersededBy) counts.superseded += 1;
    if (inv.originKind === "bugfix") counts.bugfixOrigin += 1;
    const rung = inv.fenceRung ?? "none";
    if (rung === "R0") counts.R0 += 1;
    else if (rung === "R1") counts.R1 += 1;
    else if (rung === "R2") counts.R2 += 1;
    else if (rung === "R3") counts.R3 += 1;
    else if (rung === "runtime") counts.runtime += 1;
    else counts.none += 1;
  }
  return counts;
}

async function runExtractWithScan(
  domains: HostDomains,
  scanCtx: ReturnType<typeof discoverRepo>,
): Promise<ExtractionOutput> {
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
  checkOpts?: { readonly allowRemoval?: boolean; readonly strictDrift?: boolean },
): Promise<CheckResult> {
  if (!repoDir) throw new Error("repoDir is required for featlock check.");
  const scanCtx = discoverRepo(repoDir, { languages: domains.languages.get() });
  const registry = Registry.readRepo(scanCtx.repoRoot);
  const liveExtraction = await runExtractWithScan(domains, scanCtx);
  const ctx: CheckContext = {
    repoRoot: scanCtx.repoRoot,
    registryPath: path.join(scanCtx.repoRoot, REGISTRY_SQL_REL),
    registry,
    previousRegistry: Registry.readHead(scanCtx.repoRoot),
    stagedFiles: listStagedFiles(scanCtx.repoRoot),
    allowRemoval: checkOpts?.allowRemoval ?? (process.env.ALLOW_FEATURE_REMOVAL === "1"),
    strictDrift: checkOpts?.strictDrift ?? false,
    liveExtraction,
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

function runAnalyzeMatrix(domains: HostDomains, repoDir: string, preloaded?: RegistrySnapshot): MatrixAnalysisResult {
  const scan = discoverRepo(repoDir, { languages: domains.languages.get() });
  const reg = preloaded ?? Registry.readRepo(scan.repoRoot);
  const provider = domains.analytics.get().find((a) => typeof a.analyzeMatrix === "function");
  return provider?.analyzeMatrix ? provider.analyzeMatrix(scan, reg) : EMPTY_MATRIX;
}

function runAffectedTests(
  domains: HostDomains,
  repoDir: string,
  affectedOpts?: { readonly range?: string; readonly changedFiles?: readonly string[] },
): AffectedTestsResult {
  const abs = path.resolve(repoDir);
  const reg = Registry.readRepo(abs);
  const provider = domains.analytics.get().find((a) => typeof a.affectedTests === "function");
  return provider?.affectedTests
    ? provider.affectedTests(abs, reg, affectedOpts)
    : { changedFiles: [], affectedFeatures: [], transitiveFiles: [], prioritizedTests: [] };
}

function runConcernSubgraph(
  domains: HostDomains,
  repoDir: string,
  featureId: string,
  preloaded?: RegistrySnapshot,
): ConcernSubgraphResult | null {
  const abs = path.resolve(repoDir);
  const reg = preloaded ?? Registry.readRepo(abs);
  const feat = reg.features.find((f) => f.id === featureId);
  if (!feat) return null;
  const provider = domains.analytics.get().find((a) => typeof a.concernSubgraph === "function");
  return provider?.concernSubgraph ? provider.concernSubgraph(abs, feat, reg) : null;
}

async function collectStudioDataWithDomains(
  domains: HostDomains,
  listPlugins: () => readonly PluginStatus[],
  repoDir: string,
): Promise<FeatlockStudioData> {
  if (!repoDir) throw new Error("repoDir is required to collect studio data.");
  flushAllDomains(domains);
  const absRoot = path.resolve(repoDir);
  const storedRegistry = Registry.readRepo(absRoot);
  const hasStored = storedRegistry.features.length > 0 || storedRegistry.invariants.length > 0;
  const registry: RegistrySnapshot = hasStored
    ? storedRegistry
    : { ...(await runExtractWithScan(domains, discoverRepo(absRoot, { languages: domains.languages.get() }))), relations: [], auditLog: [] };
  const check = await runCheck(domains, absRoot);
  const matrix = runAnalyzeMatrix(domains, absRoot, registry);
  const concernSubgraphs: Record<string, ConcernSubgraphResult> = {};
  for (const feat of registry.features.filter((f) => f.status === "active")) {
    const sub = runConcernSubgraph(domains, absRoot, feat.id, registry);
    if (sub) concernSubgraphs[feat.id] = sub;
  }

  let data: FeatlockStudioData = {
    schemaVersion: 1,
    repoName: path.basename(absRoot),
    repoRoot: absRoot,
    generatedAt: new Date().toISOString(),
    counts: Registry.count(registry),
    registry,
    check,
    matrix,
    concernSubgraphs,
    fenceDistribution: computeFenceDistribution(registry.invariants),
    plugins: listPlugins(),
    extensions: {},
  };

  const studioState = domains.studio.get();
  const extensions: Record<string, unknown> = {};
  for (const provider of studioState.dataProviders) {
    extensions[provider.id] = await provider.provide(data);
  }
  data = { ...data, extensions };
  for (const fn of studioState.payloadTransforms) data = fn(data);
  for (const ov of studioState.uiOverrides) {
    if (ov.transformPayload) data = ov.transformPayload(data);
  }
  return data;
}

function buildStudioRenderContext(
  domains: HostDomains,
  data: FeatlockStudioData,
  opts?: RenderStudioOptions,
): { readonly ctx: StudioRenderContext; readonly renderer: ReturnType<HostDomains["studio"]["get"]>["defaultRenderer"] } {
  if (!data) throw new Error("Studio data is required to render UI.");
  flushAllDomains(domains);
  const st = domains.studio.get();
  const tabs: StudioTabSpec[] = [...st.tabs];
  const widgets: StudioWidgetSpec[] = [...st.widgets];
  const css: string[] = [...st.css];
  const headHtml: string[] = [...st.headHtml];
  const clientScripts: string[] = [...st.clientScripts];
  const theme: Record<string, string | undefined> = {};
  let title: string | undefined;
  let brandLabel: string | undefined;

  for (const t of st.themes) Object.assign(theme, t);
  for (const ov of st.uiOverrides) {
    if (ov.title) title = ov.title;
    if (ov.brandLabel) brandLabel = ov.brandLabel;
    if (ov.theme) Object.assign(theme, ov.theme);
    if (ov.customCss) css.push(ov.customCss);
    if (ov.customHeadHtml) headHtml.push(ov.customHeadHtml);
    if (ov.customClientScript) clientScripts.push(ov.customClientScript);
    if (ov.extraTabs) tabs.push(...ov.extraTabs);
    if (ov.extraWidgets) widgets.push(...ov.extraWidgets);
  }

  tabs.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  widgets.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const renderer = opts?.rendererId
    ? (st.renderers.find((r) => r.id === opts.rendererId) ?? null)
    : (st.defaultRenderer ?? st.renderers[0] ?? null);

  return {
    renderer,
    ctx: {
      data,
      tabs,
      widgets,
      theme: theme as StudioThemeTokens,
      css,
      headHtml,
      clientScripts,
      title,
      brandLabel,
      inline: opts?.inline ?? false,
    },
  };
}

function renderFallbackStudioHtml(ctx: StudioRenderContext): string {
  const sections = ctx.tabs.map((t) => `<section data-tab="${t.id}"><h2>${t.label}</h2>${t.renderHtml(ctx.data)}</section>`).join("\n");
  const widgets = ctx.widgets.map((w) => `<article data-widget="${w.id}"><h3>${w.title}</h3>${w.renderHtml(ctx.data)}</article>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${ctx.title ?? `FeatLock · ${ctx.data.repoName}`}</title><style>${ctx.css.join("\n")}</style>${ctx.headHtml.join("\n")}</head><body>${widgets}${sections}</body></html>`;
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
  const supervisor = createPluginSupervisor({
    domains,
    includeBuiltins: opts.includeBuiltins !== false,
    repoDir: opts.repoDir,
    optionsByPlugin: opts.optionsByPlugin,
  });

  const facade: HostApiFacade = {
    listPlugins: () => supervisor.list(),
    extract: (repoDir) => runExtractWithScan(domains, discoverRepo(repoDir, { languages: domains.languages.get() })),
    check: (repoDir, checkOpts) => runCheck(domains, repoDir, checkOpts),
    sync: async (repoDir) => {
      const out = Registry.materializeDb(path.resolve(repoDir));
      return { sqlPath: out.sqlPath, dbPath: out.dbPath, counts: out.counts };
    },
    query: async (repoDir, term) => Registry.queryFeatures(Registry.readRepo(path.resolve(repoDir)), term),
    checkDup: async (repoDir, description) => Registry.findDuplicates(Registry.readRepo(path.resolve(repoDir)), description),
    recordNew: async (input) => Registry.recordNew({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    recordImprovement: async (input) => Registry.recordImprovement({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    supersedeInvariant: async (input) => Registry.supersedeInvariant({ ...input, repoRoot: path.resolve(input.repoRoot) }),
    analyzeMatrix: async (repoDir) => runAnalyzeMatrix(domains, repoDir),
    affectedTests: async (repoDir, affectedOpts) => runAffectedTests(domains, repoDir, affectedOpts),
    concernSubgraph: async (repoDir, featureId) => runConcernSubgraph(domains, repoDir, featureId),
    collectStudioData: (repoDir) => collectStudioDataWithDomains(domains, supervisor.list, repoDir),
    renderStudio: async (repoRootOrData, renderOpts) => {
      const data = typeof repoRootOrData === "string"
        ? await collectStudioDataWithDomains(domains, supervisor.list, repoRootOrData)
        : repoRootOrData;
      const { renderer, ctx } = buildStudioRenderContext(domains, data, renderOpts);
      if (renderOpts?.rendererId && !renderer) {
        throw new Error(`Studio renderer '${renderOpts.rendererId}' is not registered.`);
      }
      return renderer ? renderer.renderHtml(ctx) : renderFallbackStudioHtml(ctx);
    },
    getStudioState: () => domains.studio.get(),
    writeRegistry: async (repoDir, snapshot) => {
      const sqlPath = Registry.writeSql(path.resolve(repoDir), snapshot);
      Registry.materializeDb(path.resolve(repoDir));
      return sqlPath;
    },
    readRegistry: async (repoDir) => Registry.readRepo(path.resolve(repoDir)),
    buildAgentPasses: async (repoDir) => {
      const scanCtx = discoverRepo(repoDir, { languages: domains.languages.get() });
      const registry = Registry.readRepo(scanCtx.repoRoot);
      const packets: AgentPassPacket[] = [];
      for (const p of domains.passes.get().toSorted((a, b) => a.order - b.order)) {
        packets.push(await p.buildPacket(scanCtx, registry));
      }
      return packets;
    },
    getLanguages: () => domains.languages.get(),
    getAnalytics: () => domains.analytics.get(),
    getHarnesses: () => domains.harnesses.get(),
    getCommands: () => domains.commands.get(),
    getReporters: () => domains.reporters.get(),
  };

  await supervisor.activate(opts.plugins ?? [], opts.operations ?? []);
  return {
    ...facade,
    list: () => supervisor.list(),
    activate: (extraPlugins, operations = []) => supervisor.activate(extraPlugins, operations),
    dispose: () => supervisor.dispose(),
    runCli: (argv, repoRoot = process.cwd()) => runCliCommand(domains, facade, argv, repoRoot),
  };
}

export const PluginHost = Object.freeze({
  create: createPluginHost,
});
