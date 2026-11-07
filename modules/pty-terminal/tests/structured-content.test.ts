import { keyinUi } from "./keyin-ui.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Check, Errors } from "typebox/value";
import extension from "../src/index.ts";

const SECRET = "hunter2xyz";
const reader = `process.stdout.write('READY\\n'); process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); let buf=''; process.stdin.on('data', s => { buf += s; if (buf.includes('\\r') || buf.includes('\\n')) { process.stdout.write('GOT[' + buf.trim() + ']\\n'); setTimeout(() => process.exit(0), 300); } });`;

function setup() {
	const tools = new Map<string, any>();
	let shutdown: (() => void) | undefined;
	extension({ registerTool(tool: { name: string }) { tools.set(tool.name, tool); }, on(event: string, handler: () => void) { if (event === "session_shutdown") shutdown = handler; } } as never);
	return { tools, shutdown: () => shutdown?.() };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("every PTY tool declares an outputSchema and its structuredContent validates", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const ctx = { cwd: process.cwd(), hasUI: true };
	const run = async (name: string, params: Record<string, unknown>, context: object = ctx) => {
		const tool = tools.get(name);
		assert.ok(tool.outputSchema, `${name} outputSchema`);
		const result = await tool.execute("c", params, undefined, undefined, context);
		assert.ok(Check(tool.outputSchema, result.structuredContent), `${name}: ${JSON.stringify([...Errors(tool.outputSchema, result.structuredContent)])} ${JSON.stringify(result.structuredContent)}`);
		return result;
	};

	const spawned = await run("pty_spawn", { command: process.execPath, args: ["-e", reader] });
	const { sessionId } = spawned.structuredContent;
	assert.equal(spawned.structuredContent.sessionId, JSON.parse(spawned.content[0].text).sessionId);

	assert.equal((await run("pty_list", {})).structuredContent.length, 1);
	assert.deepEqual((await run("pty_resize", { sessionId, cols: 100, rows: 30 })).structuredContent, { sessionId, cols: 100, rows: 30 });

	let ready = "";
	for (let i = 0; i < 10 && !ready.includes("READY"); i++) {
		const read = await run("pty_read", { sessionId, timeoutMs: 1000, format: "text" });
		ready += read.structuredContent.output;
	}
	assert.match(ready, /READY/);

	// keyin: cancelled path, then delivered path; structuredContent carries only sessionId/delivered/reason.
	const { ui, type } = keyinUi();
	const keyinCtx = { cwd: process.cwd(), hasUI: true, mode: "tui", ui };
	let pending = run("pty_keyin", { sessionId, confirmPrompt: true }, keyinCtx);
	await tick();
	type("\u001b");
	assert.deepEqual((await pending).structuredContent, { sessionId, delivered: false, reason: "cancelled" });
	pending = run("pty_keyin", { sessionId, confirmPrompt: true }, keyinCtx);
	await tick();
	type(SECRET);
	type("\r");
	const keyin = await pending;
	assert.deepEqual(keyin.structuredContent, { sessionId, delivered: true });
	assert.ok(!JSON.stringify(keyin).includes(SECRET));

	// The secret echoed by the program must be masked in structuredContent as well as in the text.
	let output = "", text = "", masked = 0;
	for (let i = 0; i < 5 && !output.includes("GOT["); i++) {
		const read = await run("pty_read", { sessionId, timeoutMs: 1000, format: "text" });
		output += read.structuredContent.output; text += read.content[0].text; masked += read.structuredContent.masked ?? 0;
		assert.ok(!JSON.stringify(read.structuredContent).includes(SECRET));
	}
	assert.ok(output.includes("GOT[") && output.includes("********"), output);
	assert.ok(!output.includes(SECRET) && !text.includes(SECRET));
	assert.ok(masked > 0);

	const exit = await run("pty_wait_exit", { sessionId, timeoutMs: 5000 });
	assert.equal(typeof exit.structuredContent.exitCode, "number");
	assert.equal(JSON.stringify(exit.structuredContent), exit.content[0].text);
	assert.equal((await run("pty_kill", { sessionId })).structuredContent.released, true);
});

test("pty_write returns schema-valid structuredContent with and without readAfterMs, masking written secrets", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const ctx = { cwd: process.cwd() };
	const run = async (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		const result = await tool.execute("c", params, undefined, undefined, ctx);
		assert.ok(Check(tool.outputSchema, result.structuredContent), `${name}: ${JSON.stringify(result.structuredContent)}`);
		return result;
	};
	const { structuredContent: { sessionId } } = await run("pty_spawn", { command: process.execPath, args: ["-e", "process.stdin.resume(); process.stdout.write('hi\\n')"] });
	assert.deepEqual((await run("pty_write", { sessionId, data: "x" })).structuredContent, { sessionId });
	const withRead = await run("pty_write", { sessionId, data: "y", readAfterMs: 500, format: "text" });
	assert.equal(withRead.structuredContent.sessionId, sessionId);
	assert.equal(typeof withRead.structuredContent.output, "string");
	await run("pty_kill", { sessionId });
});
