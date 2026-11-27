import { describe, expect, test } from "bun:test";
import { discoverRepo, Registry, State } from "@featlock/core";

describe("@featlock/core unit contract", () => {
  test("State.createKeyedDomain replays transforms and Registry counts empty snapshots", () => {
    const domain = State.createKeyedDomain<{ readonly id: string }>("core-unit");
    const reg = domain.transform((ed) => ed.add({ id: "k1" }));
    expect(domain.get().map((x) => x.id)).toEqual(["k1"]);
    reg.dispose();
    expect(domain.get()).toEqual([]);
    expect(Registry.count({ features: [], tests: [], invariants: [], auditLog: [] }).features).toBe(0);
    expect(() => discoverRepo("/nonexistent/featlock/path/xyz")).toThrow();
  });
});
