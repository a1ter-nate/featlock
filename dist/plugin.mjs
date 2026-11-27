// @bun
// packages/plugin/src/index.ts
function definePlugin(def) {
  if (!def.id || def.id.trim().length === 0) {
    throw new Error("Plugin id must be a non-empty string.");
  }
  return {
    _tag: "FeatlockPlugin",
    id: def.id.trim(),
    guarded: def.guarded === true,
    setup: def.setup
  };
}
function isFeatlockPlugin(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const rec = value;
  return typeof rec.id === "string" && rec.id.length > 0 && typeof rec.setup === "function";
}
var Plugin = {
  define: definePlugin
};
export {
  Plugin,
  definePlugin,
  isFeatlockPlugin
};
