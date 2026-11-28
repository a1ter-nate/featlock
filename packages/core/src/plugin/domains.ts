import type {
  AgentPassSpec,
  AnalyticsProviderSpec,
  CheckHookEvent,
  CommandSpec,
  CustomDomainTransformHandle,
  ExtractorSpec,
  FeatlockPlugin,
  FeatlockPluginContext,
  GuardSpec,
  HarnessSpec,
  InvariantScannerSpec,
  LanguageSpec,
  PluginRegistration,
  ReporterSpec,
  StudioDataProviderSpec,
  StudioDomainSnapshot,
  StudioEditor,
  StudioPayloadTransform,
  StudioRendererSpec,
  StudioTabSpec,
  StudioThemeTokens,
  StudioUiCustomization,
  StudioWidgetSpec,
} from "@featlock/plugin";
import { State, type StateInstance } from "../state.ts";

export interface CheckHookItem {
  readonly id: string;
  readonly name: "beforeCheck" | "afterCheck";
  readonly handler: (event: CheckHookEvent) => void | Promise<void>;
}

interface MutableStudioState {
  tabs: StudioTabSpec[];
  widgets: StudioWidgetSpec[];
  dataProviders: StudioDataProviderSpec[];
  css: string[];
  themes: StudioThemeTokens[];
  headHtml: string[];
  clientScripts: string[];
  payloadTransforms: StudioPayloadTransform[];
  defaultRenderer: StudioRendererSpec | null;
  renderers: StudioRendererSpec[];
  uiOverrides: StudioUiCustomization[];
}

export interface HostDomains {
  readonly languages: ReturnType<typeof State.createKeyedDomain<LanguageSpec>>;
  readonly extractors: ReturnType<typeof State.createKeyedDomain<ExtractorSpec>>;
  readonly scanners: ReturnType<typeof State.createKeyedDomain<InvariantScannerSpec>>;
  readonly guards: ReturnType<typeof State.createKeyedDomain<GuardSpec>>;
  readonly analytics: ReturnType<typeof State.createKeyedDomain<AnalyticsProviderSpec>>;
  readonly passes: ReturnType<typeof State.createKeyedDomain<AgentPassSpec>>;
  readonly harnesses: ReturnType<typeof State.createKeyedDomain<HarnessSpec>>;
  readonly reporters: ReturnType<typeof State.createKeyedDomain<ReporterSpec>>;
  readonly commands: ReturnType<typeof State.createKeyedDomain<CommandSpec>>;
  readonly studio: StateInstance<StudioDomainSnapshot, StudioEditor>;
  readonly checkHooks: ReturnType<typeof State.createKeyedDomain<CheckHookItem>>;
  hookSeq: number;
}

function upsertById<T extends { readonly id: string }>(list: T[], item: T): void {
  const idx = list.findIndex((existing) => existing.id === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
}

function removeById<T extends { readonly id: string }>(list: T[], id: string): void {
  const idx = list.findIndex((existing) => existing.id === id);
  if (idx >= 0) list.splice(idx, 1);
}

function createStudioEditor(draft: MutableStudioState): StudioEditor {
  if (!draft) throw new Error("Studio draft state is required.");
  return {
    addTab: (tab) => upsertById(draft.tabs, tab),
    removeTab: (id) => removeById(draft.tabs, id),
    listTabs: () => draft.tabs.map((t) => ({ id: t.id, label: t.label })),
    addWidget: (widget) => upsertById(draft.widgets, widget),
    removeWidget: (id) => removeById(draft.widgets, id),
    listWidgets: () => draft.widgets.map((w) => ({ id: w.id, title: w.title })),
    addDataProvider: (provider) => upsertById(draft.dataProviders, provider),
    removeDataProvider: (id) => removeById(draft.dataProviders, id),
    listDataProviders: () => draft.dataProviders.map((d) => ({ id: d.id })),
    addCss: (css) => { if (css.trim().length > 0) draft.css.push(css); },
    setTheme: (theme) => { draft.themes.push(theme); },
    addHeadHtml: (html) => { if (html.trim().length > 0) draft.headHtml.push(html); },
    addClientScript: (script) => { if (script.trim().length > 0) draft.clientScripts.push(script); },
    addPayloadTransform: (fn) => { draft.payloadTransforms.push(fn); },
    setRenderer: (renderer) => { draft.defaultRenderer = renderer; upsertById(draft.renderers, renderer); },
    addRenderer: (renderer) => { upsertById(draft.renderers, renderer); },
    removeRenderer: (id) => {
      removeById(draft.renderers, id);
      if (draft.defaultRenderer?.id === id) draft.defaultRenderer = draft.renderers[0] ?? null;
    },
    listRenderers: () => draft.renderers.map((r) => ({ id: r.id, label: r.label })),
    setUi: (ui) => { draft.uiOverrides.push(ui); },
  };
}

export function createHostDomains(): HostDomains {
  return {
    languages: State.createKeyedDomain<LanguageSpec>("language"),
    extractors: State.createKeyedDomain<ExtractorSpec>("extractor"),
    scanners: State.createKeyedDomain<InvariantScannerSpec>("invariantScanner"),
    guards: State.createKeyedDomain<GuardSpec>("guard"),
    analytics: State.createKeyedDomain<AnalyticsProviderSpec>("analytics"),
    passes: State.createKeyedDomain<AgentPassSpec>("agentPass"),
    harnesses: State.createKeyedDomain<HarnessSpec>("harness"),
    reporters: State.createKeyedDomain<ReporterSpec>("reporter"),
    commands: State.createKeyedDomain<CommandSpec>("command"),
    studio: State.create<MutableStudioState, StudioEditor>({
      name: "studio",
      initial: () => ({
        tabs: [], widgets: [], dataProviders: [], css: [], themes: [], headHtml: [],
        clientScripts: [], payloadTransforms: [], defaultRenderer: null, renderers: [], uiOverrides: [],
      }),
      editor: createStudioEditor,
    }) as StateInstance<StudioDomainSnapshot, StudioEditor>,
    checkHooks: State.createKeyedDomain<CheckHookItem>("checkHook"),
    hookSeq: 0,
  };
}

export function flushAllDomains(domains: HostDomains): void {
  domains.languages.get(); domains.extractors.get(); domains.scanners.get(); domains.guards.get();
  domains.analytics.get(); domains.passes.get(); domains.harnesses.get(); domains.reporters.get();
  domains.commands.get(); domains.studio.get(); domains.checkHooks.get();
}

function makeHandle<TState, TEditor>(
  state: StateInstance<TState, TEditor>,
  cleanups: Array<() => Promise<void> | void>,
): CustomDomainTransformHandle<TEditor> {
  return {
    transform: async (cb) => {
      const reg = state.transform(cb);
      cleanups.push(reg.dispose);
      return reg;
    },
    reload: async () => { state.reload(); },
  };
}

export function buildPluginContext(
  domains: HostDomains,
  optionsByPlugin: Readonly<Record<string, Record<string, unknown>>> | undefined,
  plugin: FeatlockPlugin,
  cleanups: Array<() => Promise<void> | void>,
): FeatlockPluginContext {
  return {
    options: optionsByPlugin?.[plugin.id] ?? {},
    language: makeHandle(domains.languages, cleanups),
    extractor: makeHandle(domains.extractors, cleanups),
    invariantScanner: makeHandle(domains.scanners, cleanups),
    guard: makeHandle(domains.guards, cleanups),
    analytics: makeHandle(domains.analytics, cleanups),
    agentPass: makeHandle(domains.passes, cleanups),
    harness: makeHandle(domains.harnesses, cleanups),
    reporter: makeHandle(domains.reporters, cleanups),
    studio: makeHandle(domains.studio, cleanups),
    command: makeHandle(domains.commands, cleanups),
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
