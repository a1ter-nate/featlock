import { isFeatlockPlugin, type FeatlockPlugin, type PluginStatus } from "@featlock/plugin";
import { State, type RegistrationGroup } from "../state.ts";
import { buildPluginContext, flushAllDomains, type HostDomains } from "./domains.ts";
import { getBuiltinPlugins, GUARDED_PLUGIN_IDS } from "./internal.ts";
import { loadExternalPluginTarget } from "./loader.ts";

export interface PluginOperation {
  readonly type: "add" | "remove";
  readonly target: string;
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

interface CandidatePlugin {
  readonly plugin: FeatlockPlugin;
  readonly source: PluginStatus["source"];
  readonly guarded: boolean;
}

export interface PluginSupervisorHandle {
  readonly list: () => readonly PluginStatus[];
  readonly activate: (extraPlugins: readonly unknown[], operations?: readonly PluginOperation[]) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

function matchesSelector(selector: string, id: string): boolean {
  const norm = selector.trim();
  if (!norm) return false;
  if (norm === "*") return true;
  if (norm.endsWith("*")) return id.startsWith(norm.slice(0, -1));
  return norm === id;
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

async function mountPluginSlot(
  domains: HostDomains,
  slots: Map<string, ActiveSlot>,
  optionsByPlugin: Readonly<Record<string, Record<string, unknown>>> | undefined,
  candidate: CandidatePlugin,
): Promise<void> {
  if (!candidate.plugin.id) throw new Error("Plugin id is required.");
  const cleanups: Array<() => Promise<void> | void> = [];
  const slot: ActiveSlot = {
    id: candidate.plugin.id,
    source: candidate.source,
    guarded: candidate.guarded,
    cleanups,
    lifecycle: { status: "active", group: null },
  };
  slots.set(candidate.plugin.id, slot);
  const ctx = buildPluginContext(domains, optionsByPlugin, candidate.plugin, cleanups);

  try {
    const { group, result } = await State.groupAsync(
      (failure) => {
        slot.lifecycle = {
          status: "failed",
          error: failure.cause instanceof Error ? failure.cause.message : String(failure.cause),
        };
      },
      async () => await candidate.plugin.setup(ctx),
    );
    if (typeof result === "function") cleanups.push(result);
    if (slot.lifecycle.status === "active") slot.lifecycle = { status: "active", group };
    flushAllDomains(domains);
    if (slot.lifecycle.status === "failed") await disposeSlot(slot);
  } catch (err) {
    slot.lifecycle = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    await disposeSlot(slot);
  }
}

function toCandidate(plugin: FeatlockPlugin, source: PluginStatus["source"]): CandidatePlugin {
  return {
    plugin,
    source,
    guarded: plugin.guarded === true || GUARDED_PLUGIN_IDS.has(plugin.id),
  };
}

async function resolveActivationQueue(params: {
  readonly includeBuiltins: boolean;
  readonly repoDir?: string;
  readonly extraPlugins: readonly unknown[];
  readonly operations: readonly PluginOperation[];
  readonly loadFailures: ActiveSlot[];
}): Promise<CandidatePlugin[]> {
  if (!Array.isArray(params.operations)) throw new Error("operations must be an array.");
  const builtins = params.includeBuiltins ? getBuiltinPlugins() : { pre: [], post: [] };
  const preList = builtins.pre.map((p) => toCandidate(p, "builtin"));
  const inlineList = params.extraPlugins.filter(isFeatlockPlugin).map((p) => toCandidate(p, "inline"));
  const postList = builtins.post.map((p) => toCandidate(p, "builtin"));
  const externalList: CandidatePlugin[] = [];
  const enabled = new Set<string>([...preList, ...inlineList, ...postList].map((c) => c.plugin.id));
  const allKnown = (): CandidatePlugin[] => [...preList, ...inlineList, ...externalList, ...postList];

  for (const op of params.operations) {
    if (op.type === "remove") {
      for (const c of allKnown()) {
        if (!c.guarded && matchesSelector(op.target, c.plugin.id)) enabled.delete(c.plugin.id);
      }
      continue;
    }
    const matched = allKnown().filter((c) => matchesSelector(op.target, c.plugin.id));
    if (matched.length > 0 || op.target === "*" || op.target.endsWith("*")) {
      for (const c of matched) enabled.add(c.plugin.id);
      continue;
    }
    try {
      const loaded = await loadExternalPluginTarget(op.target, params.repoDir);
      for (const p of loaded.plugins) {
        const cand = toCandidate(p, loaded.source);
        externalList.push(cand);
        enabled.add(p.id);
      }
    } catch (err) {
      params.loadFailures.push({
        id: op.target,
        source: "package",
        guarded: false,
        cleanups: [],
        lifecycle: { status: "failed", error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const seen = new Set<string>();
  const deduped: CandidatePlugin[] = [];
  for (const c of allKnown()) {
    if (!enabled.has(c.plugin.id)) continue;
    if (seen.has(c.plugin.id)) {
      params.loadFailures.push({
        id: c.plugin.id,
        source: c.source,
        guarded: c.guarded,
        cleanups: [],
        lifecycle: { status: "failed", error: `Duplicate plugin ID: ${c.plugin.id}` },
      });
      continue;
    }
    seen.add(c.plugin.id);
    deduped.push(c);
  }
  return deduped;
}

export function createPluginSupervisor(params: {
  readonly domains: HostDomains;
  readonly includeBuiltins: boolean;
  readonly repoDir?: string;
  readonly optionsByPlugin?: Readonly<Record<string, Record<string, unknown>>>;
}): PluginSupervisorHandle {
  if (!params.domains) throw new Error("HostDomains instance is required.");
  const slots = new Map<string, ActiveSlot>();
  const loadFailures: ActiveSlot[] = [];

  const dispose = async (): Promise<void> => {
    for (const slot of Array.from(slots.values()).toReversed()) await disposeSlot(slot);
    slots.clear();
    loadFailures.length = 0;
  };

  const activate = async (
    extraPlugins: readonly unknown[],
    operations: readonly PluginOperation[] = [],
  ): Promise<void> => {
    await dispose();
    const queue = await resolveActivationQueue({
      includeBuiltins: params.includeBuiltins,
      repoDir: params.repoDir,
      extraPlugins,
      operations,
      loadFailures,
    });
    for (const cand of queue) await mountPluginSlot(params.domains, slots, params.optionsByPlugin, cand);
    flushAllDomains(params.domains);
  };

  const list = (): readonly PluginStatus[] =>
    [...slots.values(), ...loadFailures].map((s) =>
      s.lifecycle.status === "active"
        ? { id: s.id, source: s.source, status: "active", state: { status: "active" }, guarded: s.guarded }
        : {
            id: s.id,
            source: s.source,
            status: "failed",
            state: { status: "failed", error: s.lifecycle.error },
            guarded: s.guarded,
            error: s.lifecycle.error,
          },
    );

  return { list, activate, dispose };
}
