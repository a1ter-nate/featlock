import type { FeatlockPluginDefinition } from "./types.ts";

export interface FeatlockPlugin extends FeatlockPluginDefinition {
  readonly _tag: "FeatlockPlugin";
}

export function definePlugin(def: FeatlockPluginDefinition): FeatlockPlugin {
  if (!def.id || def.id.trim().length === 0) {
    throw new Error("Plugin id must be a non-empty string.");
  }
  return {
    _tag: "FeatlockPlugin",
    id: def.id.trim(),
    guarded: def.guarded === true,
    setup: def.setup,
  };
}

export function isFeatlockPlugin(value: unknown): value is FeatlockPlugin {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === "string" && rec.id.length > 0 && typeof rec.setup === "function";
}

export const Plugin = {
  define: definePlugin,
};

export * from "./types.ts";
