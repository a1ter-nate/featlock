export type FeatureStatus = "active" | "deprecated" | "removed";

export type InvariantSource = "ast" | "repospec" | "veristack" | "agent" | "manual" | string;

export type AuditAction = "added" | "improved" | "invariant_added" | "superseded" | "deprecated" | "removed";

export type FenceRung = "R0" | "R1" | "R2" | "R3" | "runtime" | "none";

export type InvariantOriginKind = "standard" | "bugfix";

export type FeatureRelationKind = "requires" | "excludes" | "parent_of";

export interface FeatureRelation {
  readonly fromFeatureId: string;
  readonly toFeatureId: string;
  readonly relation: FeatureRelationKind;
}

export interface FeatureRecord {
  readonly id: string;
  readonly area: string;
  readonly name: string;
  readonly summary: string;
  readonly acceptanceCriteria: string;
  readonly status: FeatureStatus;
  readonly source: string;
  readonly adrRef?: string;
  readonly removalReason?: string;
  readonly originRef?: string;
  readonly rationale?: string;
}

export interface FeatureTestLink {
  readonly featureId: string;
  readonly testPath: string;
  readonly testPattern: string;
  readonly rung: string;
}

export interface InvariantRecord {
  readonly id: string;
  readonly featureId: string;
  readonly kind: string;
  readonly statement: string;
  readonly file: string;
  readonly line: number;
  readonly confidence: number;
  readonly source: InvariantSource;
  readonly guardRef?: string;
  readonly guardAnchor?: string;
  readonly rootTestPath?: string;
  readonly fenceRung?: FenceRung;
  readonly supersededBy?: string;
  readonly enclosingSymbol?: string;
  readonly astFingerprint?: string;
  readonly originKind?: InvariantOriginKind;
  readonly originRef?: string;
  readonly rationale?: string;
  readonly status: FeatureStatus;
}

export interface AuditLogEntry {
  readonly featureId: string;
  readonly action: AuditAction;
  readonly actor: string;
  readonly summary: string;
  readonly commitSha?: string;
}

export interface RegistrySnapshot {
  readonly features: readonly FeatureRecord[];
  readonly tests: readonly FeatureTestLink[];
  readonly invariants: readonly InvariantRecord[];
  readonly relations?: readonly FeatureRelation[];
  readonly auditLog: readonly AuditLogEntry[];
}

export interface DiscoveredFile {
  readonly rel: string;
  readonly abs: string;
  readonly ext: string;
  readonly isTest: boolean;
  readonly content: string;
  readonly lines: number;
}

export interface ScanContext {
  readonly repoRoot: string;
  readonly files: readonly DiscoveredFile[];
  readonly allRelPaths: readonly string[];
  readonly readText: (relPath: string) => string | null;
}

export interface ExtractionOutput {
  readonly features: readonly FeatureRecord[];
  readonly tests: readonly FeatureTestLink[];
  readonly invariants: readonly InvariantRecord[];
}

export interface GuardViolation {
  readonly id: string;
  readonly rule: string;
  readonly severity: "error" | "warn";
  readonly featureId?: string;
  readonly file?: string;
  readonly message: string;
  readonly fix: string;
}

export interface CheckContext {
  readonly repoRoot: string;
  readonly registryPath: string;
  readonly registry: RegistrySnapshot;
  readonly previousRegistry: RegistrySnapshot | null;
  readonly stagedFiles: readonly string[];
  readonly allowRemoval: boolean;
  readonly strictDrift: boolean;
  readonly liveExtraction: ExtractionOutput;
  readonly files: readonly DiscoveredFile[];
}

export interface AgentPassPacket {
  readonly passId: string;
  readonly title: string;
  readonly objective: string;
  readonly instructions: readonly string[];
  readonly targets: readonly string[];
  readonly outputSchema: Record<string, unknown>;
}

export interface PluginRegistration {
  readonly dispose: () => Promise<void> | void;
}

export interface DomainEditor<TItem> {
  readonly list: () => readonly TItem[];
  readonly get: (id: string) => TItem | undefined;
  readonly add: (item: TItem) => void;
  readonly update: (id: string, fn: (item: TItem) => void) => void;
  readonly remove: (id: string) => void;
}

export interface DomainTransformHandle<TItem> {
  readonly transform: (cb: (editor: DomainEditor<TItem>) => void) => Promise<PluginRegistration>;
  readonly reload: () => Promise<void>;
}

export interface ExtractorSpec {
  readonly id: string;
  readonly label: string;
  readonly extract: (ctx: ScanContext) => Promise<ExtractionOutput> | ExtractionOutput;
}

export interface InvariantScannerSpec {
  readonly id: string;
  readonly source: InvariantSource;
  readonly scan: (ctx: ScanContext) => Promise<readonly InvariantRecord[]> | readonly InvariantRecord[];
}

export interface GuardSpec {
  readonly id: string;
  readonly guarded?: boolean;
  readonly evaluate: (ctx: CheckContext) => Promise<readonly GuardViolation[]> | readonly GuardViolation[];
}

export interface AgentPassSpec {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly buildPacket: (ctx: ScanContext, registry: RegistrySnapshot) => Promise<AgentPassPacket> | AgentPassPacket;
}

export interface HarnessSpec {
  readonly id: string;
  readonly label: string;
  readonly install: (repoRoot: string) => Promise<readonly string[]> | readonly string[];
  readonly uninstall: (repoRoot: string) => Promise<readonly string[]> | readonly string[];
  readonly status: (repoRoot: string) => Promise<{ readonly installed: boolean; readonly detail: string }>;
}

export interface ReporterSpec {
  readonly id: string;
  readonly format: (payload: unknown) => string;
}

export interface CommandRunContext {
  readonly repoRoot: string;
  readonly args: readonly string[];
  readonly asJson: boolean;
  readonly host: HostApiFacade;
}

export interface CommandSpec {
  readonly id: string;
  readonly description: string;
  readonly run: (ctx: CommandRunContext) => Promise<number> | number;
}

export interface CheckHookEvent {
  readonly repoRoot: string;
  readonly violations: GuardViolation[];
}

export interface SupersedeInvariantInput {
  readonly repoRoot: string;
  readonly invariantId: string;
  readonly supersededBy: string;
  readonly fenceRung?: FenceRung;
  readonly rationale?: string;
  readonly actor?: string;
}

export interface HostApiFacade {
  readonly listPlugins: () => readonly PluginStatus[];
  readonly extract: (repoRoot: string) => Promise<ExtractionOutput>;
  readonly check: (
    repoRoot: string,
    opts?: { readonly allowRemoval?: boolean; readonly strictDrift?: boolean },
  ) => Promise<CheckResult>;
  readonly sync: (repoRoot: string) => Promise<{ readonly sqlPath: string; readonly dbPath: string; readonly counts: RegistryCounts }>;
  readonly query: (repoRoot: string, term: string) => Promise<readonly FeatureRecord[]>;
  readonly checkDup: (repoRoot: string, description: string) => Promise<readonly DuplicateCandidate[]>;
  readonly recordNew: (input: {
    readonly repoRoot: string;
    readonly feature: FeatureRecord;
    readonly tests: readonly FeatureTestLink[];
    readonly invariants?: readonly InvariantRecord[];
    readonly relations?: readonly FeatureRelation[];
    readonly actor?: string;
  }) => Promise<RegistrySnapshot>;
  readonly recordImprovement: (input: {
    readonly repoRoot: string;
    readonly featureId: string;
    readonly summary: string;
    readonly extraTests?: readonly FeatureTestLink[];
    readonly extraInvariants?: readonly InvariantRecord[];
    readonly extraRelations?: readonly FeatureRelation[];
    readonly originRef?: string;
    readonly rationale?: string;
    readonly actor?: string;
  }) => Promise<RegistrySnapshot>;
  readonly supersedeInvariant: (input: SupersedeInvariantInput) => Promise<RegistrySnapshot>;
  readonly analyzeMatrix: (repoRoot: string) => Promise<{
    readonly scattering: {
      readonly dosByFeature: Readonly<Record<string, number>>;
      readonly dofByFile: Readonly<Record<string, number>>;
      readonly highScattering: readonly { readonly featureId: string; readonly files: number }[];
      readonly highTangling: readonly { readonly file: string; readonly features: readonly string[] }[];
    };
    readonly interactions: readonly {
      readonly featureA: string;
      readonly featureB: string;
      readonly sharedVia: readonly string[];
      readonly sharedTests: readonly string[];
      readonly pairwiseGap: boolean;
    }[];
    readonly flags: readonly { readonly flag: string; readonly file: string; readonly line: number; readonly status: "linked" | "unlinked" | "constant" }[];
  }>;
  readonly affectedTests: (
    repoRoot: string,
    opts?: { readonly range?: string; readonly changedFiles?: readonly string[] },
  ) => Promise<{
    readonly changedFiles: readonly string[];
    readonly affectedFeatures: readonly string[];
    readonly transitiveFiles: readonly string[];
    readonly prioritizedTests: readonly {
      readonly testPath: string;
      readonly featureIds: readonly string[];
      readonly score: number;
      readonly reason: string;
    }[];
  }>;
  readonly concernSubgraph: (
    repoRoot: string,
    featureId: string,
  ) => Promise<{
    readonly nodes: readonly string[];
    readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
    readonly crossBoundaryLeaks: readonly string[];
  } | null>;
  readonly writeRegistry: (repoRoot: string, snapshot: RegistrySnapshot) => Promise<string>;
  readonly readRegistry: (repoRoot: string) => Promise<RegistrySnapshot>;
  readonly buildAgentPasses: (repoRoot: string) => Promise<readonly AgentPassPacket[]>;
  readonly getHarnesses: () => readonly HarnessSpec[];
  readonly getCommands: () => readonly CommandSpec[];
  readonly getReporters: () => readonly ReporterSpec[];
}

export interface RegistryCounts {
  readonly features: number;
  readonly tests: number;
  readonly invariants: number;
  readonly auditEntries: number;
}

export interface DuplicateCandidate {
  readonly featureId: string;
  readonly name: string;
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

export interface CheckResult {
  readonly ok: boolean;
  readonly violations: readonly GuardViolation[];
  readonly warnings: readonly GuardViolation[];
  readonly counts: RegistryCounts;
}

export interface PluginStatus {
  readonly id: string;
  readonly source: "builtin" | "package" | "local" | "inline";
  readonly state: { readonly status: "active" | "failed"; readonly error?: string };
  readonly guarded: boolean;
}

export interface FeatlockPluginContext {
  readonly options: Record<string, unknown>;
  readonly extractor: DomainTransformHandle<ExtractorSpec>;
  readonly invariantScanner: DomainTransformHandle<InvariantScannerSpec>;
  readonly guard: DomainTransformHandle<GuardSpec>;
  readonly agentPass: DomainTransformHandle<AgentPassSpec>;
  readonly harness: DomainTransformHandle<HarnessSpec>;
  readonly reporter: DomainTransformHandle<ReporterSpec>;
  readonly command: DomainTransformHandle<CommandSpec>;
  readonly check: {
    readonly hook: (
      name: "beforeCheck" | "afterCheck",
      handler: (event: CheckHookEvent) => void | Promise<void>,
    ) => Promise<PluginRegistration>;
  };
}

export interface FeatlockPluginDefinition {
  readonly id: string;
  readonly guarded?: boolean;
  readonly setup: (ctx: FeatlockPluginContext) => Promise<void | (() => Promise<void> | void)> | void | (() => Promise<void> | void);
}

export interface FeatlockPlugin extends FeatlockPluginDefinition {
  readonly __featlockPlugin: true;
}
