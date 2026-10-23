import test from "node:test";
import assert from "node:assert/strict";
import { resolveDetachOnSteer, shouldDetachOnInput, trackForeground } from "../src/manual-detach.js";

const steer = { text: "please look at this", source: "interactive", streamingBehavior: "steer" };

test("detachOnSteer defaults on and only an explicit false disables it", () => {
  assert.equal(resolveDetachOnSteer(undefined), true);
  assert.equal(resolveDetachOnSteer({}), true);
  assert.equal(resolveDetachOnSteer({ "pi-shell-tools": { detachOnSteer: true } }), true);
  assert.equal(resolveDetachOnSteer({ "pi-shell-tools": { detachOnSteer: "no" } }), true);
  assert.equal(resolveDetachOnSteer({ "pi-shell-tools": { detachOnSteer: false } }), false);
});

test("only an interactive non-empty non-slash steer message triggers detach", () => {
  assert.equal(shouldDetachOnInput(steer, undefined), true);
  assert.equal(shouldDetachOnInput({ ...steer, streamingBehavior: "followUp" }, undefined), false);
  assert.equal(shouldDetachOnInput({ ...steer, streamingBehavior: undefined }, undefined), false);
  assert.equal(shouldDetachOnInput({ ...steer, source: "rpc" }, undefined), false);
  assert.equal(shouldDetachOnInput({ ...steer, source: "extension" }, undefined), false);
  assert.equal(shouldDetachOnInput({ ...steer, text: "   " }, undefined), false);
  assert.equal(shouldDetachOnInput({ ...steer, text: "  /compact" }, undefined), false);
  assert.equal(shouldDetachOnInput(steer, { "pi-shell-tools": { detachOnSteer: false } }), false);
});

test("input handler detaches tracked foreground work once and never swallows the message", async () => {
  const { ensureDetachShortcut } = await import("../src/manual-detach.js");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let settings: unknown = undefined;
  const pi = {
    registerShortcut() {},
    getSettings: () => settings,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
  };
  const notes: string[] = [];
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  const root = globalThis as unknown as Record<symbol, unknown>;
  const ownerKey = Symbol.for("pi-better-tools.foreground-detach.shortcut-owner.v1");
  const previousOwner = root[ownerKey];
  delete root[ownerKey];
  try {
    ensureDetachShortcut(pi as never);
    const input = handlers.get("input")!;
    let detached = 0;
    const untrack = trackForeground("call-1", () => { detached++; });

    assert.deepEqual(input({ ...steer, streamingBehavior: "followUp" }, ctx), { action: "continue" });
    assert.equal(detached, 0);

    assert.deepEqual(input(steer, ctx), { action: "continue" });
    assert.equal(detached, 1);
    assert.equal(notes.length, 1);

    settings = { "pi-shell-tools": { detachOnSteer: false } };
    input(steer, ctx);
    assert.equal(detached, 1, "disabled by setting");

    untrack();
    settings = undefined;
    input(steer, ctx);
    assert.equal(notes.length, 1, "no foreground work: nothing happens");
  } finally {
    if (previousOwner) root[ownerKey] = previousOwner; else delete root[ownerKey];
  }
});
