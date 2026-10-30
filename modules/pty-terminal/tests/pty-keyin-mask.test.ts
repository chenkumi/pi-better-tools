import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.ts";
import { MASK } from "../src/secret-mask.ts";

const SECRET = "ThisIsPassword";
/** The terminal echoes what is typed (cooked mode), then the program reports it as an unknown command, like a shell would. */
const echoing = `process.stdout.write('READY\\n'); process.stdin.setEncoding('utf8'); process.stdin.once('data', s => { process.stdout.write('bash: ' + s.trim() + ': command not found\\n'); setTimeout(() => process.exit(0), 50); });`;
const atShellPrompt = `process.stdout.write('sudo: a password is required\\n[admin@localhost ~]$ '); setInterval(() => {}, 1000);`;
/** Shows a password prompt and gives up when it is sent GIVEUP (like sudo timing out); afterwards it behaves like a shell and reports any input. */
const timesOut = `process.stdout.write('[sudo] password for admin: '); let gaveUp = false; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { if (!gaveUp && s.includes('GIVEUP')) { gaveUp = true; process.stdout.write('sudo: timed out reading password\\n[admin@localhost ~]$ '); } else if (gaveUp) process.stdout.write('GOT[' + JSON.stringify(s) + ']'); }); setInterval(() => {}, 1000);`;

function setup() {
	const tools = new Map<string, any>();
	let shutdown: (() => void) | undefined;
	extension({ registerTool(tool: { name: string }) { tools.set(tool.name, tool); }, on(event: string, handler: () => void) { if (event === "session_shutdown") shutdown = handler; } } as never);
	return { tools, shutdown: () => shutdown?.() };
}
function fakeUi() {
	const state: { component?: any } = {};
	const ui = { custom: (factory: any) => new Promise((resolve) => { state.component = factory({ requestRender() {} }, {}, {}, (value: unknown) => resolve(value)); }) };
	return { ui, type: (text: string) => state.component.handleInput(text) };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ctx = (ui: unknown) => ({ cwd: process.cwd(), hasUI: true, ui });

async function spawn(tools: Map<string, any>, script: string) {
	const spawned = await tools.get("pty_spawn").execute("s", { command: process.execPath, args: ["-e", script] }, undefined, undefined, { cwd: process.cwd() });
	return (JSON.parse(spawned.content[0].text) as { sessionId: string }).sessionId;
}
async function readUntil(tools: Map<string, any>, sessionId: string, pattern: RegExp, args: Record<string, unknown> = {}) {
	let text = "", last: any;
	// A re-read (since) returns at once, so poll it; a draining read already waits for new output.
	const rereading = args.since !== undefined;
	for (let i = 0; i < (rereading ? 100 : 10) && !pattern.test(text); i++) {
		if (rereading && i > 0) await sleep(100);
		last = await tools.get("pty_read").execute("r", { sessionId, timeoutMs: 1000, ...args });
		text = rereading ? last.content[0].text : text + last.content[0].text;
	}
	return { text, last };
}
async function keyin(tools: Map<string, any>, sessionId: string, extra: Record<string, unknown> = {}) {
	const { ui, type } = fakeUi();
	const pending = tools.get("pty_keyin").execute("k", { sessionId, ...extra }, undefined, undefined, ctx(ui));
	await tick();
	return { pending, enter: (secret: string) => { type(secret); type("\r"); } };
}

test("a secret the program echoes back is masked in pty_read, with a notice, in raw and text format", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, echoing);
	await readUntil(tools, sessionId, /READY/);
	const { pending, enter } = await keyin(tools, sessionId);
	enter(SECRET);
	assert.equal((await pending).details.delivered, true);
	for (const format of ["raw", "text"] as const) {
		const { text, last } = await readUntil(tools, sessionId, /command not found/, { format, since: format === "text" ? 0 : undefined });
		assert.ok(!text.includes(SECRET) && !text.includes("ThisIs"), text);
		assert.ok(text.includes(`bash: ${MASK}: command not found`), text);
		assert.match(text, /masked as \*{8}/);
		assert.ok(last.details.masked >= 1);
	}
});

test("pty_write with readAfterMs and a waitFor pattern cannot reveal the secret", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, echoing);
	await readUntil(tools, sessionId, /READY/);
	const { pending, enter } = await keyin(tools, sessionId);
	enter(SECRET);
	await pending;
	await sleep(300);
	const probe = await tools.get("pty_read").execute("r", { sessionId, since: 0, waitFor: "ThisIs", timeoutMs: 300 });
	assert.match(probe.content[0].text, /waitFor not matched/, "a pattern on the secret must not match");
	const hit = await tools.get("pty_read").execute("r", { sessionId, since: 0, waitFor: "command not found", timeoutMs: 1000 });
	assert.ok(!hit.details.waitFor || hit.details.waitFor === "matched");
	assert.ok(!JSON.stringify(hit).includes(SECRET));
});

test("pty_keyin refuses to open while the last line is a shell prompt, and confirmPrompt overrides it", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, atShellPrompt);
	await readUntil(tools, sessionId, /\$ $/);
	const { ui } = fakeUi();
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, ctx(ui)), /not opened.*shell prompt/s);
	const { pending, enter } = await keyin(tools, sessionId, { confirmPrompt: true });
	enter("anything");
	assert.equal((await pending).details.delivered, true);
});

test("pty_keyin does not send when the prompt timed out while the dialog was open", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, timesOut);
	await readUntil(tools, sessionId, /password for admin: /);
	const { pending, enter } = await keyin(tools, sessionId);
	await tools.get("pty_write").execute("w", { sessionId, data: "GIVEUP\r" }); // sudo gives up and the shell prompt returns while the user is still typing
	await readUntil(tools, sessionId, /timed out reading password/);
	enter(SECRET);
	const result = await pending;
	assert.equal(result.details.delivered, false);
	assert.equal(result.details.reason, "prompt_gone");
	assert.match(result.content[0].text, /Nothing was sent/);
	assert.ok(!JSON.stringify(result).includes(SECRET));
	await sleep(200);
	const { text } = await readUntil(tools, sessionId, /timed out/, { since: 0 });
	assert.ok(!text.includes("GOT["), "nothing may have reached the session");
	assert.ok(!text.includes(SECRET));
});

test("a secret stays masked after the session exited, until the session is released", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, echoing);
	await readUntil(tools, sessionId, /READY/);
	const { pending, enter } = await keyin(tools, sessionId);
	enter(SECRET);
	await pending;
	await tools.get("pty_wait_exit").execute("w", { sessionId, timeoutMs: 3000 });
	const { text } = await readUntil(tools, sessionId, /command not found/, { since: 0 });
	assert.ok(!text.includes(SECRET), text);
});

/** After a secret was entered, prints a line that ends in an unfinished echo of it, like a shell redrawing its prompt. */
const partialEcho = `process.stdout.write('READY\\n'); process.stdin.setEncoding('utf8'); process.stdin.once('data', () => { process.stdout.write('\\nhost$ ThisIs'); }); setInterval(() => {}, 1000);`;
const passportHost = `process.stdout.write('user@passport-host:~$ '); setInterval(() => {}, 1000);`;

test("the refusal text never contains a partial echo of an entered secret", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, partialEcho);
	await readUntil(tools, sessionId, /READY/);
	const first = await keyin(tools, sessionId);
	first.enter(SECRET);
	await first.pending;
	await readUntil(tools, sessionId, /host\$/, { since: 0 });
	const { ui } = fakeUi();
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, ctx(ui)), (error: Error) => {
		assert.match(error.message, /not opened/);
		assert.ok(!error.message.includes("ThisIs"), error.message);
		return true;
	});
});

test("a shell prompt is refused even when the host name contains a secret-like word", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, passportHost);
	await readUntil(tools, sessionId, /\$ $/);
	const { ui } = fakeUi();
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, ctx(ui)), /not opened.*shell prompt/s);
});

test("an ambiguous prompt ending in > is still accepted when it asks for a secret", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdout.write('Enter token >'); process.stdin.on('data', () => {}); setInterval(() => {}, 1000);`);
	await readUntil(tools, sessionId, /token >/);
	const { pending, enter } = await keyin(tools, sessionId);
	enter("abc123");
	assert.equal((await pending).details.delivered, true);
});

test("a failed write registers no secret", async (t) => {
	const { tools, shutdown } = setup();
	t.after(shutdown);
	const sessionId = await spawn(tools, `process.stdout.write('Password: '); process.exit(0);`);
	await readUntil(tools, sessionId, /Password: /);
	await tools.get("pty_wait_exit").execute("w", { sessionId, timeoutMs: 3000 });
	const { ui } = fakeUi();
	await assert.rejects(tools.get("pty_keyin").execute("k", { sessionId }, undefined, undefined, ctx(ui)), /exited/);
	const output = await readUntil(tools, sessionId, /Password: /, { since: 0 });
	assert.ok(!output.text.includes(MASK), "nothing was ever masked in this session");
});
