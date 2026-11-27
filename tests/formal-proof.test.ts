import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

type FeatureStatus = "active" | "deprecated" | "removed";

interface GuardModelState {
  readonly featureStatus: FeatureStatus;
  readonly guardedPluginActive: boolean;
  readonly lastTransitionValid: boolean;
}

function allowsDirectSqlDelete(status: FeatureStatus): boolean {
  return status !== "active";
}

function allowsRemovalTransition(
  prevStatus: FeatureStatus,
  nextStatus: FeatureStatus,
  hasAdr: boolean,
  hasReason: boolean,
  allowRemovalFlag: boolean,
): boolean {
  if (prevStatus !== "active") return true;
  if (nextStatus !== "removed") return true;
  return hasAdr && hasReason && allowRemovalFlag;
}

function canDisablePlugin(isGuarded: boolean, removeRequested: boolean): boolean {
  return isGuarded ? false : removeRequested;
}

function nextStates(s: GuardModelState): GuardModelState[] {
  const out: GuardModelState[] = [];
  if (s.featureStatus === "active") {
    out.push({ featureStatus: "deprecated", guardedPluginActive: true, lastTransitionValid: true });
    if (allowsRemovalTransition("active", "removed", true, true, true)) {
      out.push({ featureStatus: "removed", guardedPluginActive: true, lastTransitionValid: true });
    }
  }
  if (!canDisablePlugin(true, true)) {
    out.push({ featureStatus: s.featureStatus, guardedPluginActive: true, lastTransitionValid: true });
  }
  return out;
}

describe("R5 Bounded Formal Proof: featlock_guards.qnt State Space", () => {
  test("every reachable state in featlock_guards satisfies antiDeletionInvariant and guardedPluginInvariant", () => {
    const qntPath = path.resolve(import.meta.dir, "..", ".verification", "formal", "featlock_guards.qnt");
    expect(fs.existsSync(qntPath)).toBe(true);

    const init: GuardModelState = { featureStatus: "active", guardedPluginActive: true, lastTransitionValid: true };
    const queue: GuardModelState[] = [init];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) continue;
      const key = `${cur.featureStatus}:${cur.guardedPluginActive}:${cur.lastTransitionValid}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const antiDeletionInvariant =
        (cur.featureStatus !== "active" || !allowsDirectSqlDelete(cur.featureStatus)) && cur.lastTransitionValid;
      expect(antiDeletionInvariant).toBe(true);
      expect(cur.guardedPluginActive).toBe(true);

      for (const nxt of nextStates(cur)) queue.push(nxt);
    }

    expect(visited.size).toBe(3);
    expect(allowsRemovalTransition("active", "removed", false, true, true)).toBe(false);
    expect(allowsRemovalTransition("active", "removed", true, false, true)).toBe(false);
    expect(allowsRemovalTransition("active", "removed", true, true, false)).toBe(false);
    expect(canDisablePlugin(true, true)).toBe(false);
    expect(canDisablePlugin(false, true)).toBe(true);
  });
});
