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

test("write keys + waitFor/format/since work end to end on a real PTY, with slim text and cancel keeps the session", async (t) => {
	const tools = new Map<string, any>();
	let shutdownHandler: (() => void) | undefined;
	extension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool), on: (event: string, handler: () => void) => { if (event === "session_shutdown") shutdownHandler = handler; } } as never);
	t.after(() => shutdownHandler?.());
	const context = { cwd: process.cwd() };
	const spawned = await tools.get("pty_spawn").execute("s", { command: process.execPath, args: ["-e", interactive] }, undefined, undefined, context);
	assert.deepEqual(JSON.parse(spawned.content[0].text), { sessionId: spawned.details.sessionId });
	const { sessionId } = spawned.details as { sessionId: string };
	const read = (params: object, signal?: AbortSignal) => tools.get("pty_read").execute("r", { sessionId, ...params }, signal);

	const ready = await read({ waitFor: "READY", timeoutMs: 20_000, format: "text" });
	assert.match(ready.content[0].text, /^READY/);
	assert.match(ready.content[0].text, /\[cursor 0-\d+\]/);
	assert.equal(ready.details.waitFor, "matched");
	const cursor = ready.details.cursor.to as number;
	const again = await read({ since: 0, timeoutMs: 0, format: "text" });
	assert.match(again.content[0].text, /^READY/);
	await assert.rejects(read({ waitFor: "(" }), /Invalid waitFor/);
	await assert.rejects(tools.get("pty_write").execute("w", { sessionId, keys: ["Hyper-Q"] }), /Supported keys: .*Enter/);
	await assert.rejects(tools.get("pty_write").execute("w", { sessionId }), /data and\/or keys/);

	const controller = new AbortController();
	const pending = read({ waitFor: "never-appears", timeoutMs: 30_000 }, controller.signal);
	controller.abort(new Error("cancelled"));
	await assert.rejects(pending, /cancelled/);
	assert.equal(JSON.parse((await tools.get("pty_list").execute("l", {})).content[0].text)[0].sessionId, sessionId);

	const written = await tools.get("pty_write").execute("w", { sessionId, data: "hi", keys: ["Enter"], readAfterMs: 0 });
	// A zero-delay drain may contain the terminal's input echo before the
	// child reply. The reply is independently required by waitFor below.
	assert.ok(["ok", "received:hi", "hi\r\n"].some(text => written.content[0].text.includes(text)), JSON.stringify(written));
	assert.equal(written.details.sessionId, sessionId);
	if (written.content[0].text !== "ok") {
		assert.equal(typeof written.details.cursor.from, "number");
		assert.ok(written.details.cursor.to > written.details.cursor.from);
	}
	const out = await read({ waitFor: "received:hi", timeoutMs: 20_000, since: cursor });
	assert.match(out.content[0].text, /received:hi/);
	assert.equal(typeof cursor, "number");
});

test("local spawn applies pi-pty-terminal.env allow/deny from effective settings", async (t) => {
	const tools = new Map<string, any>();
	let shutdownHandler: (() => void) | undefined;
	let settings: unknown = {};
	extension({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool), on: (event: string, handler: () => void) => { if (event === "session_shutdown") shutdownHandler = handler; }, getSettings: () => settings } as never);
	t.after(() => shutdownHandler?.());
	process.env.PTY_TEST_SECRET = "leak";
	t.after(() => { delete process.env.PTY_TEST_SECRET; });
	const code = "process.stdout.write('V=' + (process.env.PTY_TEST_SECRET ?? 'none') + ';X=' + (process.env.PTY_TEST_EXPLICIT ?? 'none') + ';')";
	const run = async (config: unknown) => {
		settings = { "pi-pty-terminal": config };
		const spawned = await tools.get("pty_spawn").execute("s", { command: process.execPath, args: ["-e", code], env: { PTY_TEST_EXPLICIT: "yes" } }, undefined, undefined, { cwd: process.cwd() });
		const out = await tools.get("pty_read").execute("r", { sessionId: spawned.details.sessionId, waitFor: "V=\\w+;X=\\w+;", timeoutMs: 20_000, format: "text" });
		return out.content[0].text as string;
	};
	assert.match(await run({}), /V=leak;X=yes;/);
	assert.match(await run({ env: { deny: ["PTY_TEST_*"] } }), /V=none;X=yes;/);
	assert.match(await run({ env: { allow: ["PATH", "SystemRoot", "SYSTEMROOT", "PATHEXT", "TEMP", "TMP", "windir"] } }), /V=none;X=yes;/);
	await assert.rejects(run({ env: { allow: "PATH" } }), /pi-pty-terminal\.env\.allow/);
});
