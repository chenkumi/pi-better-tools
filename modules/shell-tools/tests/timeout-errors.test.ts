import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import shell from "../extensions/timeout-ms.ts";

// Exercise the real outer execute catch without starting a backend or reading personal settings.
test("timeout errors retain unmatched identity and wrap only the host trailing diagnostic once", async context => {
  context.mock.method(fsPromises, "stat", async () => { throw Object.assign(new Error("isolated diagnostics"), { code: "ENOENT" }); });
  syncBuiltinESMExports();
  const tools: any[] = [];
  let fault: unknown;
  const pi = { registerTool: (tool: any) => tools.push(tool), on() {}, registerToolRenderer() {}, registerMessageRenderer() {}, registerCommand() {},
    getSettings() { throw fault; } };
  try {
    shell(pi as never);
    const tool = tools.find(tool => tool.name === "bash");
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "timeout-characterization" } };
    async function failure(value: unknown, timeoutMs?: number) {
      fault = value;
      let rejected = false, observed: unknown;
      await tool.execute("failure", { command: "MUST_NOT_SPAWN", timeoutMs }, undefined, undefined, ctx)
        .then(() => assert.fail("settings error must reject execution"), (error: unknown) => { rejected = true; observed = error; });
      assert.equal(rejected, true);
      return observed;
    }
    const ordinary = new Error("non-timeout failure");
    const diagnostic = new Error("output\n\nCommand timed out after 2 seconds");
    for (const value of [undefined, null, false, 0, { message: diagnostic.message }, ordinary]) {
      assert.strictEqual(await failure(value, 2000), value);
    }
    assert.strictEqual(await failure(diagnostic), diagnostic, "omitted timeout preserves the original diagnostic");
    const wrapped = await failure(diagnostic, 2000) as Error;
    assert.notStrictEqual(wrapped, diagnostic);
    assert.strictEqual(wrapped.cause, diagnostic);
    assert.match(wrapped.message, /timeoutMs total timeout/);
    assert.equal(wrapped.message.startsWith("output\n\n"), true);
    assert.strictEqual(await failure(wrapped, 2000), wrapped, "already normalized errors are not wrapped again");
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
