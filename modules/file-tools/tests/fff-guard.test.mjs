import assert from "node:assert/strict";
import { test } from "node:test";
import { createCursorLedger, guardFffTool } from "../src/fff-guard.mjs";

// Fake pi-fff tool host: mimics upstream's result text and thrown errors without the native finder.
function fakeTool(name, execute) {
  return { name, label: name, description: "d", parameters: { marker: name }, execute };
}
const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });

test("cursor issued by FFF is accepted on the next call; unknown cursor is rejected without running the search", async () => {
  let calls = 0;
  const grep = guardFffTool(
    fakeTool("grep", async (_id, params) => {
      calls++;
      return text(params.cursor ? "page 2" : 'hit\n\n[Continue with cursor="fff_c1"]');
    }),
    createCursorLedger(),
  );
  await grep.execute("1", { pattern: "x" });
  assert.equal((await grep.execute("2", { pattern: "x", cursor: "fff_c1" })).content[0].text, "page 2");
  await assert.rejects(
    grep.execute("3", { pattern: "x", cursor: "fff_c99" }),
    (error) =>
      /parameter "cursor" "fff_c99" is unknown or expired/.test(error.message) &&
      /Omit cursor to restart the search from page 1/.test(error.message),
  );
  assert.equal(calls, 2);
});

test("grep and multi_grep share cursors; find cursors are a separate family; empty cursor is a fresh search", async () => {
  const ledger = createCursorLedger();
  const grep = guardFffTool(fakeTool("grep", async () => text('[Continue with cursor="fff_c1"]')), ledger);
  const multi = guardFffTool(fakeTool("multi_grep", async () => text("ok")), ledger);
  const find = guardFffTool(fakeTool("find", async () => text('[3 more matches available. cursor="7" to continue]')), ledger);
  await grep.execute("1", {});
  await find.execute("2", {});
  assert.equal((await multi.execute("3", { cursor: "fff_c1" })).content[0].text, "ok");
  assert.equal((await multi.execute("4", { cursor: "" })).content[0].text, "ok");
  await assert.rejects(find.execute("5", { cursor: "fff_c1" }), /unknown or expired/);
  await assert.rejects(grep.execute("6", { cursor: "7" }), /unknown or expired/);
  assert.equal((await find.execute("7", { cursor: "7" })).content[0].text, '[3 more matches available. cursor="7" to continue]');
});

test("not-initialized errors become cause + fix messages and keep the original as cause", async () => {
  for (const [name, raw] of [
    ["grep", "FFF picker factory is not initialized"],
    ["find", "FFF auxiliary finder pool is not initialized"],
  ]) {
    const tool = guardFffTool(
      fakeTool(name, async () => {
        throw new Error(raw);
      }),
      createCursorLedger(),
    );
    await assert.rejects(tool.execute("1", { pattern: "x" }), (error) => {
      assert.match(error.message, new RegExp(`^${name}: the FFF search index is not available`));
      assert.match(error.message, /Cause:/);
      assert.match(error.message, /retry/);
      assert.match(error.message, /read\/ls/);
      assert.match(error.message, /\/fff-mode/);
      assert.match(error.message, /\/fff-health/);
      assert.doesNotMatch(error.message, /--fff-mode|PI_FFF_MODE|pi-fff\.json|agentDir/);
      assert.equal(error.cause.message, raw);
      return true;
    });
  }
});

test("path constraint and empty patterns errors name the parameter and the fix", async () => {
  const grep = guardFffTool(
    fakeTool("grep", async () => {
      throw new Error("Path constraint must be relative to the workspace: /etc/passwd");
    }),
    createCursorLedger(),
  );
  await assert.rejects(grep.execute("1", { pattern: "x", path: "/etc/passwd" }), (error) => {
    assert.match(error.message, /parameter "path" must be relative to the workspace \(got "\/etc\/passwd"\)/);
    assert.match(error.message, /read\/ls/);
    return true;
  });
  const multi = guardFffTool(
    fakeTool("multi_grep", async () => {
      throw new Error("patterns array must have at least 1 element");
    }),
    createCursorLedger(),
  );
  await assert.rejects(multi.execute("1", { patterns: [] }), /parameter "patterns" must be a non-empty array/);
});

test("unrelated errors, abort errors and non-search tools pass through untouched", async () => {
  const original = new Error("Operation aborted");
  const grep = guardFffTool(
    fakeTool("grep", async () => {
      throw original;
    }),
    createCursorLedger(),
  );
  await assert.rejects(grep.execute("1", {}), (error) => error === original);
  const other = fakeTool("ffstatus", async () => text("ok"));
  assert.equal(guardFffTool(other), other);
});

test("wrapper preserves name, schema and every other definition field", () => {
  const tool = { ...fakeTool("find", async () => text("")), promptGuidelines: ["g"], renderCall() {} };
  const guarded = guardFffTool(tool, createCursorLedger());
  for (const key of ["name", "label", "description", "parameters", "promptGuidelines", "renderCall"]) {
    assert.equal(guarded[key], tool[key]);
  }
});
