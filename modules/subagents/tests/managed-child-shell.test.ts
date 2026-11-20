import assert from "node:assert/strict";
import test from "node:test";
import * as childArgs from "../extensions/subagent/child-args.ts";

test("every managed launch environment explicitly binds foreground Shell to its guard", () => {
  const build = (childArgs as any).buildManagedChildEnvironment;
  assert.equal(typeof build, "function");
  const expected = { id: "managed", cwd: "/workspace", startupPath: "/startup", bridgeToken: "private" };
  const env = build(expected);
  assert.deepEqual(JSON.parse(env.PI_SUBAGENTS_GUARD), { ...expected, shellMode: "foreground-v1" });
  assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined, "parent environment is not mutated");
  const rpc = childArgs.buildSubagentPiArgs({ persistence: { kind: "resume", sessionDir: "/managed", sessionFile: "/managed/native" }, transport: "rpc", guardPath: "/guard", taskPath: "" });
  assert.equal(rpc[rpc.indexOf("--exclude-tools") + 1], "subagent,agent_status,agent_cancel,agent_message,spinoff,mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource");
  assert.ok(rpc.includes("/guard"));
});
