import type {
  CheckResult,
  PluginStatus,
  RegistryCounts,
  RegistrySnapshot,
} from "./types.ts";

export interface MatrixScattering {
  readonly dosByFeature: Readonly<Record<string, number>>;
  readonly dofByFile: Readonly<Record<string, number>>;
  readonly highScattering: readonly { readonly featureId: string; readonly files: number }[];
  readonly highTangling: readonly { readonly file: string; readonly features: readonly string[] }[];
}

export interface FeatureInteractionRecord {
  readonly featureA: string;
  readonly featureB: string;
  readonly sharedVia: readonly string[];
  readonly sharedTests: readonly string[];
  readonly pairwiseGap: boolean;
}

export interface FeatureFlagAuditRecord {
  readonly flag: string;
  readonly file: string;
  readonly line: number;
  readonly status: "linked" | "unlinked" | "constant";
}

export interface MatrixAnalysisResult {
  readonly scattering: MatrixScattering;
  readonly interactions: readonly FeatureInteractionRecord[];
  readonly flags: readonly FeatureFlagAuditRecord[];
}

export interface AffectedTestsResult {
  readonly changedFiles: readonly string[];
  readonly affectedFeatures: readonly string[];
  readonly transitiveFiles: readonly string[];
  readonly prioritizedTests: readonly {
    readonly testPath: string;
    readonly featureIds: readonly string[];
    readonly score: number;
    readonly reason: string;
  }[];
}

export interface ConcernSubgraphResult {
  readonly nodes: readonly string[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
  readonly crossBoundaryLeaks: readonly string[];
}

export interface FenceDistribution {
  readonly R0: number;
  readonly R1: number;
  readonly R2: number;
  readonly R3: number;
  readonly runtime: number;
  readonly none: number;
  readonly bugfixOrigin: number;
  readonly superseded: number;
}

export interface FeatlockStudioData {
  readonly schemaVersion: 1;
  readonly repoName: string;
  readonly repoRoot: string;
  readonly generatedAt: string;
  readonly counts: RegistryCounts;
  readonly registry: RegistrySnapshot;
  readonly check: CheckResult;
  readonly matrix: MatrixAnalysisResult;
  readonly concernSubgraphs: Readonly<Record<string, ConcernSubgraphResult>>;
  readonly fenceDistribution: FenceDistribution;
  readonly plugins: readonly PluginStatus[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface StudioThemeTokens {
  readonly bg?: string;
  readonly surface?: string;
  readonly panel?: string;
  readonly border?: string;
  readonly text?: string;
  readonly muted?: string;
  readonly accent?: string;
  readonly ok?: string;
  readonly warn?: string;
  readonly danger?: string;
  readonly fontSans?: string;
  readonly fontMono?: string;
}

export interface StudioTabSpec {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly badge?: string | ((data: FeatlockStudioData) => string | undefined);
  readonly renderHtml: (data: FeatlockStudioData) => string;
  readonly clientScript?: string;
}

export interface StudioWidgetSpec {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly renderHtml: (data: FeatlockStudioData) => string;
}

export interface StudioDataProviderSpec {
  readonly id: string;
  readonly provide: (data: FeatlockStudioData) => Promise<unknown> | unknown;
}

export interface StudioHttpRouteSpec {
  readonly method?: "GET" | "POST";
  readonly path: string;
  readonly handle: (
    req: Request,
    getData: () => Promise<FeatlockStudioData>,
  ) => Promise<Response> | Response;
}

export interface StudioRenderContext {
  readonly data: FeatlockStudioData;
  readonly tabs: readonly StudioTabSpec[];
  readonly widgets: readonly StudioWidgetSpec[];
  readonly theme: StudioThemeTokens;
  readonly css: readonly string[];
  readonly headHtml: readonly string[];
  readonly clientScripts: readonly string[];
  readonly title?: string;
  readonly brandLabel?: string;
  readonly inline: boolean;
}

export interface StudioRendererSpec {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  readonly renderHtml: (ctx: StudioRenderContext) => string;
  readonly routes?: readonly StudioHttpRouteSpec[];
}

export type StudioPayloadTransform = (data: FeatlockStudioData) => FeatlockStudioData;

export interface StudioUiCustomization {
  readonly title?: string;
  readonly brandLabel?: string;
  readonly theme?: StudioThemeTokens;
  readonly customCss?: string;
  readonly customHeadHtml?: string;
  readonly customClientScript?: string;
  readonly extraTabs?: readonly StudioTabSpec[];
  readonly extraWidgets?: readonly StudioWidgetSpec[];
  readonly transformPayload?: StudioPayloadTransform;
}

export interface StudioEditor {
  readonly addTab: (tab: StudioTabSpec) => void;
  readonly removeTab: (id: string) => void;
  readonly listTabs: () => readonly { readonly id: string; readonly label: string }[];
  readonly addWidget: (widget: StudioWidgetSpec) => void;
  readonly removeWidget: (id: string) => void;
  readonly listWidgets: () => readonly { readonly id: string; readonly title: string }[];
  readonly addDataProvider: (provider: StudioDataProviderSpec) => void;
  readonly removeDataProvider: (id: string) => void;
  readonly listDataProviders: () => readonly { readonly id: string }[];
  readonly addCss: (css: string) => void;
  readonly setTheme: (theme: StudioThemeTokens) => void;
  readonly addHeadHtml: (html: string) => void;
  readonly addClientScript: (script: string) => void;
  readonly addPayloadTransform: (fn: StudioPayloadTransform) => void;
  readonly setRenderer: (renderer: StudioRendererSpec) => void;
  readonly addRenderer: (renderer: StudioRendererSpec) => void;
  readonly removeRenderer: (id: string) => void;
  readonly listRenderers: () => readonly { readonly id: string; readonly label?: string }[];
  readonly setUi: (ui: StudioUiCustomization) => void;
}

export interface StudioDomainSnapshot {
  readonly tabs: readonly StudioTabSpec[];
  readonly widgets: readonly StudioWidgetSpec[];
  readonly dataProviders: readonly StudioDataProviderSpec[];
  readonly css: readonly string[];
  readonly themes: readonly StudioThemeTokens[];
  readonly headHtml: readonly string[];
  readonly clientScripts: readonly string[];
  readonly payloadTransforms: readonly StudioPayloadTransform[];
  readonly defaultRenderer: StudioRendererSpec | null;
  readonly renderers: readonly StudioRendererSpec[];
  readonly uiOverrides: readonly StudioUiCustomization[];
}
