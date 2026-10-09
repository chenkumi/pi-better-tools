import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../extensions/json-schema.ts";

const schema = '{"type":"object","required":["a"],"properties":{"a":{"type":"number"}}}';
async function fixture(activeTools: string[], complete: (...args: unknown[]) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "json-recovery-regression-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension({ registerFlag() {}, registerTool() {},
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, handler),
    getFlag: (name: string) => name === "json-schema" ? schema : name === "json-output" ? "out.json" : undefined,
    getActiveTools: () => activeTools,
  } as never);
  // This registry is a local stub, with no credentials or real provider calls.
  const ctx = { mode: "print", cwd: dir, model: { id: "offline-stub" }, modelRegistry: { find: () => undefined, complete } };
  const call = (name: string, event = {}) => hooks.get(name)!(event, ctx);
  call("session_start"); call("input");
  return { dir, call, output: async () => JSON.parse(await readFile(join(dir, "out.json"), "utf8")),
    close: async () => { await call("session_shutdown"); await rm(dir, { recursive: true, force: true }); } };
}

test("M9: local recovery skips invalid objects/arrays and picks the FIRST schema-valid result without extraction", async () => {
  const f = await fixture([], async () => { assert.fail("extraction is disabled for local recovery"); });
  try {
    const message = { role: "assistant", content: [{ type: "text", text: '{} [1] {"a":"wrong"} {"a":7} {"a":8}' }], stopReason: "stop" };
    const replacement = f.call("message_end", { message }) as { message: unknown };
    f.call("agent_end", { messages: [replacement.message] });
    await f.call("session_shutdown");
    assert.deepEqual(await f.output(), { a: 7 });
  } finally { await f.close(); }
});

for (const useOriginal of [false, true]) {
  test(`M8/M9: fallback retains ordered original text exactly once (host original=${useOriginal}) and validates reply candidates`, async () => {
    let seen = "", calls = 0;
    const f = await fixture(["json_output"], async (_model, request) => {
      calls++;
      seen = (request as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content[0].text;
      return { stopReason: "stop", content: [{ type: "text", text: '```json\n{}\n```\n[1] {"a":9} {"a":10}' }] };
    });
    try {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "intermediate-original-α" }] },
        { role: "assistant", stopReason: "stop", content: [
          { type: "text", text: "final-original-β" }, { type: "text", text: "final-original-γ" },
        ] },
      ];
      const replacements = messages.map(message => (f.call("message_end", { message }) as { message: unknown }).message);
      f.call("agent_end", { messages: useOriginal ? messages : replacements });
      await f.call("session_shutdown");
      assert.equal(calls, 1);
      for (const text of ["intermediate-original-α", "final-original-β", "final-original-γ"]) assert.equal(seen.split(text).length - 1, 1, text);
      assert.ok(seen.indexOf("intermediate-original-α") < seen.indexOf("final-original-β"));
      assert.ok(seen.indexOf("final-original-β") < seen.indexOf("final-original-γ"));
      assert.deepEqual(await f.output(), { a: 9 });
      assert.deepEqual(messages[1].content.map(block => block.text), ["final-original-β", "final-original-γ"], "event messages remain untouched");
    } finally { await f.close(); }
  });
}
