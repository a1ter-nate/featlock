export {
  countRegistry,
  findDuplicateFeatures,
  loadSnapshotFromSql,
  materializeRegistryDb,
  queryRegistryFeatures,
  readHeadRegistry,
  readRepoRegistry,
  recordFeatureImprovement,
  recordNewFeature,
  REGISTRY_DB_REL,
  REGISTRY_SQL_REL,
  serializeRegistrySql,
  writeRegistrySql,
} from "./db/registry.ts";
export { discoverRepo, listStagedFiles } from "./discover.ts";
export {
  createPluginHost,
  PluginHost,
  type PluginHostInstance,
  type PluginHostOptions,
  type PluginOperation,
} from "./plugin/host.ts";
export { batch, createKeyedDomainState, createState, State, type StateInstance } from "./state.ts";
