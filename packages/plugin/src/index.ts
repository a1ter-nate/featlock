import type { FeatlockPluginDefinition } from "./types.ts";

const PLUGIN_BRAND = Symbol.for("featlock.plugin");

export interface FeatlockPlugin extends FeatlockPluginDefinition {
  readonly _tag: "FeatlockPlugin";
  readonly [PLUGIN_BRAND]: true;
}

export function definePlugin(def: FeatlockPluginDefinition): FeatlockPlugin {
  if (!def || typeof def.id !== "string" || def.id.trim().length === 0) {
    throw new Error("Plugin id must be a non-empty string.");
  }
  if (typeof def.setup !== "function") {
    throw new Error(`Plugin '${def.id}' requires a setup(ctx) function.`);
  }
  return Object.freeze({
    _tag: "FeatlockPlugin" as const,
    [PLUGIN_BRAND]: true as const,
    id: def.id.trim(),
    guarded: def.guarded === true,
    setup: def.setup,
  });
}

export function isFeatlockPlugin(value: unknown): value is FeatlockPlugin {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<PropertyKey, unknown>;
  if (rec[PLUGIN_BRAND] === true) return true;
  return typeof rec.id === "string" && rec.id.length > 0 && typeof rec.setup === "function";
}

export const Plugin = Object.freeze({
  define: definePlugin,
});

export * from "./studio-types.ts";
export * from "./types.ts";
