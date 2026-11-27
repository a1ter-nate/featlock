import { Plugin } from "@featlock/plugin";

export default Plugin.define({
  id: "featlock.config",
  async setup(ctx) {
    await ctx.reporter.transform((ed) => {
      ed.add({
        id: "json",
        format: (payload) => JSON.stringify(payload, null, 2),
      });
    });
  },
});
