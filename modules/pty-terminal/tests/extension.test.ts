import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.ts";
import { interactive } from "./fixture.ts";

test("registers every PTY tool and a session shutdown handler", () => {
	const tools: Array<{ name: string }> = [];
	let shutdownHandler: (() => void) | undefined;

	extension({
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") shutdownHandler = handler;
		},
	} as never);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["pty_spawn", "pty_write", "pty_read", "pty_resize", "pty_wait_exit", "pty_kill", "pty_list"],
	);
	assert.ok(shutdownHandler);
	shutdownHandler();
});

test("the registered tools control a real PTY session", async (t) => {
	const tools = new Map<string, any>();
	let shutdownHandler: (() => void) | undefined;
	extension({
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") shutdownHandler = handler;
		},
	} as never);

	t.after(() => shutdownHandler?.());
	const context = { cwd: process.cwd() };
	const spawned = await tools.get("pty_spawn").execute(
		"call-1",
		{ command: process.execPath, args: ["-e", interactive] },
		undefined,
		undefined,
		context,
	);
	const { sessionId } = JSON.parse(spawned.content[0].text) as { sessionId: string };

	let ready = "";
	for (let i = 0; i < 10 && !ready.includes("READY"); i++) {
		ready += (await tools.get("pty_read").execute("ready", { sessionId, timeoutMs: 1000 })).content[0].text;
	}
	assert.match(ready, /READY/);
	assert.equal(spawned.details.target, "local");
	await tools.get("pty_write").execute("call-2", { sessionId, data: "hello\\r" }, undefined, undefined, context);
	let output = "";
	for (let attempt = 0; attempt < 3 && !output.includes("received:hello"); attempt += 1) {
		const result = await tools.get("pty_read").execute(
			"call-read",
			{ sessionId, timeoutMs: 2_000 },
			undefined,
			undefined,
			context,
		);
		output += result.content[0].text;
	}
	assert.match(output, /received:hello/);
	shutdownHandler?.();
});
