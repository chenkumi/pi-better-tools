import assert from "node:assert/strict";
import test from "node:test";
import extension, { PTY_TOOL_NAMES } from "../src/index.ts";

// Activation of tool_search, the fallback and the discovery hint belong to pi-runtime (modules/pi-runtime tests).
test("every PTY tool is deferred in one pty namespace and the name list matches the registrations", async () => {
	const tools: any[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	extension({ registerTool: (tool: unknown) => { tools.push(tool); }, on: (event: string, handler: any) => { handlers.set(event, handler); } } as never);
	assert.deepEqual(tools.map(tool => tool.name), [...PTY_TOOL_NAMES]);
	for (const tool of tools) {
		assert.equal(tool.exposure, "deferred", tool.name);
		assert.equal(tool.namespace.name, "pty", tool.name);
		assert.notEqual(tool.defaultActive, true, tool.name);
	}
	assert.equal(handlers.has("before_agent_start"), false, "no module-local discovery hint");
	await handlers.get("session_shutdown")!({}, {});
});
