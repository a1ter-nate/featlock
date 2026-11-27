import { Plugin } from "@featlock/plugin";

export default Plugin.define({
  id: "featlock.demo.toggle",
  async setup(ctx) {
    await ctx.extractor.transform((ed) => {
      ed.add({
        id: "featlock.demo.toggle.extractor",
        label: "Demo Toggle Feature Extractor",
        extract: () => ({
          features: [
            {
              id: "feat.demo.toggle-canary",
              area: "demo-toggle",
              name: "Demo Toggle Canary Feature",
              summary: "Emitted only when @featlock/plugin-demo-toggle is enabled.",
              acceptanceCriteria: "Present when plugin is ON; absent with zero residue when plugin is OFF.",
              status: "active",
              source: "demo-toggle",
            },
          ],
          tests: [],
          invariants: [
            {
              id: "inv:demo:toggle-canary",
              featureId: "feat.demo.toggle-canary",
              kind: "demo-canary",
              statement: "Demo toggle canary invariant is active while plugin is mounted.",
              file: "package.json",
              line: 1,
              confidence: 1,
              source: "demo-toggle",
              status: "active",
            },
          ],
        }),
      });
    });

    await ctx.command.transform((ed) => {
      ed.add({
        id: "demo-ping",
        description: "Verify @featlock/plugin-demo-toggle is active",
        run: (c) => {
          console.log(c.asJson ? JSON.stringify({ demoToggle: "ON", pluginId: "featlock.demo.toggle" }) : "demo-toggle plugin is ON");
          return 0;
        },
      });
    });
  },
});
