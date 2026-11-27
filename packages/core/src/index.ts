export { Registry, REGISTRY_DB_REL, REGISTRY_SQL_REL, type RecordImprovementInput, type RecordNewFeatureInput } from "./db/registry.ts";
export { discoverRepo, listStagedFiles } from "./discover.ts";
export {
  createPluginHost,
  PluginHost,
  type PluginHostInstance,
  type PluginHostOptions,
  type PluginOperation,
} from "./plugin/host.ts";
export { State, type StateInstance } from "./state.ts";
