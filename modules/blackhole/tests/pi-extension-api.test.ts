import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
import { describe, expect, it } from "vitest";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

describe("extension API double", () => {
  it("preserves callback argument types through capture and replay", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          tsc,
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          "tests/fixtures/pi-extension-api.typecheck.ts",
        ],
        { cwd: moduleRoot, encoding: "utf8", stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("fails loudly for an unused host member", () => {
    expect(() => createExtensionApiDouble().getFlag("unused")).toThrow(
      "createExtensionApiDouble: getFlag is not implemented",
    );
  });
});
