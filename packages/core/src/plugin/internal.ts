import type { FeatlockPlugin } from "@featlock/plugin";
import antiDeletionGuardPlugin, { GuardAnalytics } from "../../../plugins/anti-deletion-guard/src/index.ts";

export { GuardAnalytics };
import astScannerPlugin from "../../../plugins/ast-scanner/src/index.ts";
import configPlugin from "../../../plugins/config/src/index.ts";
import harnessesPlugin from "../../../plugins/harnesses/src/index.ts";
import invariantPassesPlugin from "../../../plugins/invariant-passes/src/index.ts";
import registryCliPlugin from "../../../plugins/registry-cli/src/index.ts";
import repospecBridgePlugin from "../../../plugins/repospec-bridge/src/index.ts";
import veristackBridgePlugin from "../../../plugins/veristack-bridge/src/index.ts";

const pre: readonly FeatlockPlugin[] = [
  astScannerPlugin,
  repospecBridgePlugin,
  veristackBridgePlugin,
  invariantPassesPlugin,
  antiDeletionGuardPlugin,
  harnessesPlugin,
  registryCliPlugin,
];

const post: readonly FeatlockPlugin[] = [configPlugin];

export const GUARDED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  antiDeletionGuardPlugin.id,
]);

export function getBuiltinPlugins(): {
  readonly pre: readonly FeatlockPlugin[];
  readonly post: readonly FeatlockPlugin[];
} {
  return { pre, post };
}
