import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { slugifyIdentifier } from "../../../../packages/plugins/ast-scanner/src/polyglot.ts";

class SlugCmd implements fc.Command<{ maxLen: number }, { seen: string[] }> {
  constructor(readonly raw: string) {}
  check(): boolean { return true; }
  run(model: { maxLen: number }, real: { seen: string[] }): void {
    const slug = slugifyIdentifier(this.raw);
    expect(slug.length).toBeLessThanOrEqual(model.maxLen);
    expect(/^[a-z0-9-]*$/.test(slug)).toBe(true);
    real.seen.push(slug);
  }
}

describe("@featlock/plugin-ast-scanner MBT contract", () => {
  test("slugifyIdentifier always produces bounded lowercase slugs", () => {
    fc.assert(
      fc.property(
        fc.commands([fc.string({ minLength: 1, maxLength: 90 }).map((s) => new SlugCmd(s))], { maxCommands: 10 }),
        (cmds) => {
          fc.modelRun(() => ({ model: { maxLen: 64 }, real: { seen: [] } }), cmds);
        },
      ),
      { numRuns: 20 },
    );
  });
});
