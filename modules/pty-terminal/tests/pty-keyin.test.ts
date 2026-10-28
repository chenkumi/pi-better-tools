import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.ts";
import { SecretInput } from "../src/secret-input.ts";

const SECRET = "p@ss\\x41w0rd\\n'\"é";
/** Reads one line from the PTY and reports it, so delivery is observable through pty_read. */
const reader = `process.stdout.write('READY\\n'); process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); let buf=''; process.stdin.on('data', s => { buf += s; if (buf.includes('\\r') || buf.includes('\\n')) { process.stdout.write('GOT[' + JSON.stringify(buf) + ']\\n'); process.exit(0); } });`;

function setup() {
	const tools = new Map<string, any>();
	let shutdown: (() => void) | undefined;
	extension({ registerTool(tool: { name: string }) { tools.set(tool.name, tool); }, on(event: string, handler: () => void) { if (event === "session_shutdown") shutdown = handler; } } as never);
	return { tools, shutdown: () => shutdown?.() };
}

/** UI whose custom() hands the component to the test and resolves when the component calls done(). */
function fakeUi() {
	const state: { component?: any; shown: number } = { shown: 0 };
	const ui = {
		custom: (factory: any) => new Promise((resolve) => {
			state.shown++;
			state.component = factory({ requestRender() {} }, {}, {}, (value: unknown) => resolve(value));
		}),
	};
	return { ui, state, type: (text: string) => state.component.handleInput(text) };
}

async function spawn(tools: Map<string, any>, script: string) {
	const spawned = await tools.get("pty_spawn").execute("s", { command: process.execPath, args: ["-e", script] }, undefined, undefined, { cwd: process.cwd() });
	const { sessionId } = JSON.parse(spawned.content[0].text) as { sessionId: string };
	let ready = "";
	for (let i = 0; i < 10 && !ready.includes("READY"); i++) ready += (await tools.get("pty_read").execute("r", { sessionId, timeoutMs: 1000 })).content[0].text;
	assert.match(ready, /READY/);
	return sessionId;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("pty_keyin sends the typed secret verbatim plus Enter and never returns it", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, reader);
	const { ui, type } = fakeUi();
	const pending = tools.get("pty_keyin").execute("k", { sessionId, prompt: "sudo password" }, undefined, undefined, { cwd: process.cwd(), hasUI: true, ui });
	await tick();
	type(SECRET);
	type("\r");
	const result = await pending;
	assert.equal(result.details.delivered, true);
	assert.ok(!JSON.stringify(result).includes(SECRET));
	assert.ok(!JSON.stringify(result).includes("w0rd"));
	let output = "";
	for (let i = 0; i < 5 && !output.includes("GOT["); i++) output += (await tools.get("pty_read").execute("r", { sessionId, timeoutMs: 1000, format: "text" })).content[0].text;
	assert.ok(output.includes(`GOT[${JSON.stringify(`${SECRET}\r`)}]`), output);
});

test("pty_keyin cancel sends nothing and reports it", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, reader);
	const { ui, type } = fakeUi();
	const pending = tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: true, ui });
	await tick();
	type("hunter2");
	type("\x1b");
	const result = await pending;
	assert.equal(result.details.delivered, false);
	assert.equal(result.details.reason, "cancelled");
	assert.ok(!JSON.stringify(result).includes("hunter2"));
	const output = (await tools.get("pty_read").execute("r", { sessionId, timeoutMs: 300 })).content[0].text;
	assert.ok(!output.includes("GOT["));
});

test("pty_keyin refuses without UI, unknown or exited sessions, and a second dialog, without showing a dialog", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, reader);
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: false }), /interactive Pi UI/);
	const { ui, state } = fakeUi();
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId: "pty-none" }, undefined, undefined, { cwd: process.cwd(), hasUI: true, ui }), /pty-none/);
	assert.equal(state.shown, 0);
	const first = tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: true, ui });
	await tick();
	await assert.rejects(tools.get("pty_keyin").execute("k2", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: true, ui }), /already open/);
	state.component.handleInput("\x1b");
	await first;
});

test("pty_keyin aborts without writing when the tool call is aborted or the session exits", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, reader);
	const abort = new AbortController();
	const { ui, type } = fakeUi();
	const pending = tools.get("pty_keyin").execute("k", { sessionId }, abort.signal, undefined, { cwd: process.cwd(), hasUI: true, ui });
	await tick();
	type("abc");
	abort.abort();
	const result = await pending;
	assert.equal(result.details.reason, "aborted");
	// Make the program exit by itself, then a new dialog must refuse.
	await tools.get("pty_kill").execute("kill", { sessionId });
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: true, ui }), /pty-/);
});

test("SecretInput renders a boxed mask with cursor and code-point count as input changes", () => {
	let renders = 0;
	const input = new SecretInput({ header: ["Prompt"], requestRender: () => { renders++; }, onSubmit() {}, onCancel() {} });
	const field = (width: number) => input.render(width)[3];
	const counter = (width: number) => input.render(width)[4];
	const empty = input.render(40);
	assert.equal(empty.length, 6);
	for (const i of [0, 2, 3, 4]) assert.equal(empty[i].length, 40);
	assert.equal(empty[0], "─".repeat(40));
	assert.equal(empty[1], " Prompt");
	assert.equal(empty[2], `╭─ PTY KeyIn ${"─".repeat(26)}╮`);
	assert.equal(field(40), `│ _${" ".repeat(35)} │`);
	assert.equal(counter(40), `╰${"─".repeat(28)} 0 chars ─╯`);
	assert.equal(input.render(100)[5], " The text you type goes straight to the session; the agent never sees it.");
	input.handleInput("a😀");
	assert.equal(field(40), `│ **_${" ".repeat(33)} │`);
	assert.match(counter(40), / 2 chars ─╯$/);
	input.handleInput("\x1b[200~xy\r\n\x1b[201~");
	assert.match(field(40), /^│ \*\*\*\*_ +│$/);
	input.handleInput("\x7f");
	assert.match(field(40), /^│ \*\*\*_ +│$/);
	assert.match(counter(40), / 3 chars ─╯$/);
	input.handleInput("\x15");
	assert.match(field(40), /^│ _ +│$/);
	assert.equal(renders, 4);
	input.handleInput("secret".repeat(30));
	const narrow = input.render(30);
	assert.equal(narrow[3], `│ ${"*".repeat(25)}_ │`);
	assert.match(narrow[4], / 180 chars ─╯$/);
	assert.ok(!narrow.join("\n").includes("secret"));
	input.dispose();
	assert.match(input.render(40)[4], / 0 chars ─╯$/);
});

test("SecretInput masks, keeps backslashes, handles paste, backspace and kitty/escape input", () => {
	let sent: string | undefined;
	let cancelled = false;
	const make = () => new SecretInput({ header: ["h"], onSubmit: (v) => { sent = v; }, onCancel: () => { cancelled = true; } });
	const input = make();
	input.handleInput("a\\n");
	input.handleInput("\x1b[200~pa");
	input.handleInput("ss\r\n\x1b[201~");
	input.handleInput("x");
	input.handleInput("\x7f");
	input.handleInput("\x1b[A"); // arrow keys are ignored
	assert.ok(!input.render(80).join("\n").includes("pass"));
	assert.ok(!input.render(80).join("\n").includes("a\\n"));
	input.handleInput("\r");
	assert.equal(sent, "a\\npass");
	assert.equal(cancelled, false);
	input.handleInput("z"); // finished: ignored
	assert.equal(sent, "a\\npass");

	sent = undefined;
	const other = make();
	other.handleInput("x");
	other.handleInput("\x03");
	assert.equal(cancelled, true);
	assert.equal(sent, undefined);
});
