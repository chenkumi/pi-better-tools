import { expect, it } from "vitest";
import sqlConnectorExtension from "../src/index.ts";

// The guard handshake is consumed once per process and stays set, so this file holds only the child case (vitest isolates files).
it("a Subagent child gets no database tools, command or event handlers", () => {
  process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ shellMode: "foreground-v1", id: "child", cwd: process.cwd(), startupPath: process.cwd() });
  const calls: string[] = [];
  const pi = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push(`${String(name)}:${String(args[0])}`); } }) as never;
  sqlConnectorExtension(pi);
  expect(calls).toEqual([]);
});
