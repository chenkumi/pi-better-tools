import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sqliteExtension from "../src/index.ts";

// The guard handshake is consumed once per process and stays set, so this file holds only the child case.
test("a Subagent child gets no sqlite tools, command or event handlers", () => {
  process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ shellMode: "foreground-v1", id: "child", cwd: process.cwd(), startupPath: process.cwd() });
  const calls: string[] = [];
  const pi = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push(`${String(name)}:${String(args[0])}`); } }) as unknown as ExtensionAPI;
  sqliteExtension(pi);
  assert.deepEqual(calls, []);
});
