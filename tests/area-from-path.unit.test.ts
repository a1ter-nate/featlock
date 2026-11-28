import { describe, expect, test } from "bun:test";
import { areaFromPath } from "../packages/plugins/ast-scanner/src/index.ts";

describe("@featlock/plugin-ast-scanner areaFromPath pure unit tests", () => {
  test("maps monorepo apps, packages, plugins, crates, modules, and src subfeatures cleanly", () => {
    expect(areaFromPath("apps/cloud-api/src/index.ts", ".ts")).toBe("app:cloud-api");
    expect(areaFromPath("packages/plugins/studio/src/render.ts", ".ts")).toBe("plugin:studio");
    expect(areaFromPath("packages/billing-ui/src/card.tsx", ".tsx")).toBe("billing-ui");
    expect(areaFromPath("crates/engine/src/lib.rs", ".rs")).toBe("crate:engine");
    expect(areaFromPath("modules/auth/main.go", ".go")).toBe("module:auth");
    expect(areaFromPath("src/middleware/cors/index.ts", ".ts")).toBe("middleware:cors");
  });
});
