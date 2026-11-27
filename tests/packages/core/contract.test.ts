import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { State } from "@featlock/core";

class AddKeyCmd implements fc.Command<Set<string>, ReturnType<typeof State.createKeyedDomain<{ readonly id: string }>>> {
  constructor(readonly id: string) {}
  check(): boolean { return true; }
  run(model: Set<string>, real: ReturnType<typeof State.createKeyedDomain<{ readonly id: string }>>): void {
    real.transform((ed) => ed.add({ id: this.id }));
    model.add(this.id);
    expect(real.get().length).toBe(model.size);
  }
}

const createCoreMbtState = () => ({
  model: new Set<string>(),
  real: State.createKeyedDomain<{ readonly id: string }>("core-mbt"),
});

describe("@featlock/core MBT contract", () => {
  test("State.createKeyedDomain preserves unique keys across arbitrary command sequences", () => {
    fc.assert(
      fc.property(
        fc.commands([fc.constantFrom("a", "b", "c", "d").map((id) => new AddKeyCmd(id))], { maxCommands: 10 }),
        (cmds) => {
          fc.modelRun(createCoreMbtState, cmds);
        },
      ),
      { numRuns: 20 },
    );
  });
});
