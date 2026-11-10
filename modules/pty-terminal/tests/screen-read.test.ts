import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.ts";
import { MASK } from "../src/secret-mask.ts";
import { keyinUi } from "./keyin-ui.ts";

function setup() {
	const tools = new Map<string, any>();
	let shutdown: (() => void) | undefined;
	extension({ getActiveTools: () => ["bash"], registerTool(tool: { name: string }) { tools.set(tool.name, tool); }, on(event: string, handler: () => void) { if (event === "session_shutdown") shutdown = handler; } } as never);
	return { tools, shutdown: () => shutdown?.() };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const E = "String.fromCharCode(27)", CRLF = "String.fromCharCode(13,10)";
// No backslashes in the child programs: Windows passes them through a command line.
async function spawn(tools: Map<string, any>, script: string, extra: Record<string, unknown> = {}) {
	const spawned = await tools.get("pty_spawn").execute("s", { command: process.execPath, args: ["-e", script], ...extra }, undefined, undefined, { cwd: process.cwd() });
	return (JSON.parse(spawned.content[0].text) as { sessionId: string }).sessionId;
}
const read = (tools: Map<string, any>, sessionId: string, params: Record<string, unknown> = {}) => tools.get("pty_read").execute("r", { sessionId, timeoutMs: 3000, ...params });

test("format screen returns the rendered screen: overwrites applied, no control characters, cursor reported", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `const e=${E};process.stdout.write('hello'+${CRLF}+'world'+e+'[1;1Hjump'+e+'[31m!'+e+'[0m');setInterval(()=>{},1000)`, { cols: 40, rows: 6 });
	const out = await read(tools, sessionId, { format: "screen", waitFor: "world" });
	const text: string = out.content[0].text;
	assert.match(text, /^jump!\nworld\n\[screen 40x6; cursor line 1 column 6\]$/);
	assert.doesNotMatch(text, /\x1b/);
	assert.equal(out.details.format, "screen");
	assert.deepEqual(out.details.screen, { cols: 40, rows: 6, alternate: false, cursor: { line: 1, column: 6 }, changed: true });
	assert.equal(out.structuredContent.output, "jump!\nworld");
});

test("a screen read with nothing new returns the screen again, marked unchanged, after at most timeoutMs", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdout.write('static');setInterval(()=>{},1000)`);
	const first = await read(tools, sessionId, { format: "screen", waitFor: "static" });
	assert.equal(first.details.screen.changed, true);
	const second = await read(tools, sessionId, { format: "screen", timeoutMs: 200 });
	assert.equal(second.details.screen.changed, false);
	assert.match(second.content[0].text, /^static\n\[screen \d+x\d+; cursor line 1 column 7; screen unchanged since the last screen read\]$/);
});

test("a screen read counts the stream as delivered, and since is refused for the screen", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdout.write('abc');setInterval(()=>{},1000)`);
	await read(tools, sessionId, { format: "screen", waitFor: "abc" });
	const stream = await read(tools, sessionId, { timeoutMs: 100, format: "text" });
	assert.doesNotMatch(stream.content[0].text, /abc/, "the stream up to the screen read is already delivered");
	await assert.rejects(read(tools, sessionId, { format: "screen", since: 0 }), /since does not apply to format screen/);
});

test("pty_write readAfterMs can return the screen", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('got:'+d.trim()+${CRLF}));setInterval(()=>{},1000)`);
	const out = await tools.get("pty_write").execute("w", { sessionId, data: "ping\\r", readAfterMs: 800, format: "screen" });
	assert.match(out.content[0].text, /got:ping/);
	assert.equal(out.details.format, "screen");
});

test("the screen text is masked like the stream", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('typed:'+d.trim()+${CRLF}));setInterval(()=>{},1000)`);
	const { ui, type } = keyinUi();
	const pending = tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: true, mode: "tui", ui });
	await tick();
	type("ThisIsPassword"); type("\r");
	assert.equal((await pending).details.delivered, true);
	const out = await read(tools, sessionId, { format: "screen", waitFor: "typed:", timeoutMs: 5000 });
	assert.ok(!out.content[0].text.includes("ThisIsPassword") && !out.content[0].text.includes("ThisIs"), out.content[0].text);
	assert.ok(out.content[0].text.includes(`typed:${MASK}`), out.content[0].text);
	assert.ok(out.details.masked >= 1);
	assert.ok(!JSON.stringify(out).includes("ThisIs"), "no field of the result carries the secret");
});

test("a program on the alternate screen gets a hint on stream reads, and format screen shows what is drawn", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `const e=${E};process.stdout.write(e+'[?1049h'+e+'[2J'+e+'[3;5HMENU'+e+'[5;5H> item');setInterval(()=>{},1000)`, { cols: 30, rows: 8 });
	const raw = await read(tools, sessionId, { format: "text", waitFor: "item" });
	assert.match(raw.content[0].text, /using the full screen.*format "screen"/);
	assert.equal(raw.details.fullscreen, true);
	const screen = await read(tools, sessionId, { format: "screen" });
	assert.equal(screen.details.screen.alternate, true);
	assert.match(screen.content[0].text, /^\n\n    MENU\n\n    > item\n\[screen 30x8 full screen;/);
});

test("a partial secret at the end of the screen is masked, not dropped", async (t) => {
	const { tools, shutdown } = setup(); t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdin.setEncoding('utf8');process.stdin.on('data',()=>process.stdout.write('end:ThisIs'));setInterval(()=>{},1000)`);
	const { ui, type } = keyinUi();
	const pending = tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: true, mode: "tui", ui });
	await tick();
	type("ThisIsPassword"); type("\r");
	await pending;
	const out = await read(tools, sessionId, { format: "screen", waitFor: "end:", timeoutMs: 5000 });
	assert.ok(!out.content[0].text.includes("ThisIs"), out.content[0].text);
	assert.match(out.content[0].text, /\nend:\*{8}\n/);
});
