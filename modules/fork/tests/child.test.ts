import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { startForkChild, type ForkChildSpec } from "../src/child.ts";
import { CHANNEL } from "../src/child-guard.ts";
import { FORK_GUARD_ENV } from "../src/identity.ts";

/** Scripted stand-in for the Pi RPC child: same framing, no process. */
function fakeProc(script: { onRequest?: (cmd: any, reply: (data?: unknown, ok?: boolean) => void) => void } = {}) {
	const proc: any = new EventEmitter();
	const lines: any[] = []; let buffer = "";
	proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.connected = true; proc.pid = undefined; proc.killed = [] as string[];
	proc.stdin = new Writable({ write(chunk, _enc, cb) {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const command = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); lines.push(command);
			const reply = (data?: unknown, ok = true) => proc.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: ok, ...(ok ? { data } : { error: "no" }) }) + "\n");
			script.onRequest ? script.onRequest(command, reply) : reply({});
		}
		cb();
	} });
	proc.send = (message: any, cb?: () => void) => { cb?.(); return true; };
	proc.kill = (signal: string) => { proc.killed.push(signal); return true; };
	proc.ipc = (message: Record<string, unknown>) => proc.emit("message", { channel: CHANNEL, ...message });
	proc.exit = (code = 0) => proc.emit("close", code);
	return { proc, lines };
}
const spec = (proc: any, over: Partial<ForkChildSpec> = {}): ForkChildSpec & { token?: string } => ({ jobId: "J", sessionId: "S1", sessionPath: __filename_unused, sessionDir: "/d", cwd: "/w", model: "p/m", thinkingLevel: "off", tools: ["read"], trusted: false,
	guardPath: "/g.ts", forwarded: [], prompt: "PROMPT", invocation: () => ({ command: "pi", args: [] }), spawnImpl: ((_c: string, _a: string[], options: any) => { tokenOf(options.env); return proc; }) as never, closeGraceMs: 5, killGraceMs: 5, ...over });
const __filename_unused = "/nonexistent-but-unused.jsonl";
let lastToken = "";
const tokenOf = (env: Record<string, string>) => { lastToken = JSON.parse(env[FORK_GUARD_ENV]!).token; };
const ipc = (proc: any, message: Record<string, unknown>) => proc.ipc({ token: lastToken, ...message });
const stats = (total: number) => ({ tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total }, cost: total / 100 });
const happyScript = (state: { n: number }) => ({ onRequest(cmd: any, reply: (d?: unknown, ok?: boolean) => void) {
	if (cmd.type === "get_state") reply({ sessionId: "S1" });
	else if (cmd.type === "get_session_stats") reply(stats(state.n += 10));
	else if (cmd.type === "prompt") reply({ disposition: "started" });
	else if (cmd.type === "get_last_assistant_text") reply({ text: "FINAL" });
	else reply({});
} });

test("happy path: handshake, task over RPC (not argv), quiescent settle, bounded usage delta, orderly close", async () => {
	const state = { n: 0 }; const { proc, lines } = fakeProc(happyScript(state));
	const phases: string[] = [];
	const handle = startForkChild(spec(proc), p => phases.push(p));
	ipc(proc, { type: "verified", tools: ["read", "extra_unlisted_fork_free"].slice(0, 1) });
	await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: true });
	setImmediate(() => proc.exit(0));
	const outcome = await handle.done;
	assert.equal(outcome.status, "completed"); assert.equal(outcome.output, "FINAL");
	assert.deepEqual(outcome.usage, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.1 }, "inherited history is subtracted");
	assert.equal(outcome.childClosed, true);
	assert.deepEqual(lines.map(l => l.type), ["get_state", "get_session_stats", "prompt", "get_last_assistant_text", "get_session_stats"]);
	assert.equal(lines.find(l => l.type === "prompt").message, "PROMPT");
	assert.deepEqual(phases, ["running", "finalizing"]);
});

test("a settle before the prompt, or while not quiet, never completes the Fork", async () => {
	const { proc } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc));
	ipc(proc, { type: "settled", quiet: true }); // premature: before verification/prompt
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: false });
	let done = false; void handle.done.then(() => { done = true; });
	await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
	assert.equal(done, false);
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	assert.equal((await handle.done).status, "completed");
});

test("messages with a wrong token or channel are ignored", async () => {
	const { proc } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc));
	proc.emit("message", { channel: CHANNEL, token: "forged", type: "verified", tools: ["read"] });
	proc.emit("message", { channel: "other", token: lastToken, type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	proc.exit(1);
	const outcome = await handle.done;
	assert.equal(outcome.status, "failed"); assert.equal(outcome.errorCode, "CHILD_EXITED");
});

test("guard rejection, tool-set mismatch and identity mismatch fail before the prompt", async () => {
	for (const [name, act, code] of [
		["rejected", (p: any) => ipc(p, { type: "rejected", code: "TRUST_REQUIRED" }), "TRUST_REQUIRED"],
		["extra tool", (p: any) => ipc(p, { type: "verified", tools: ["read", "bash"] }), "CAPABILITY_MISMATCH"],
		["fork tool visible but ignored", (p: any) => ipc(p, { type: "verified", tools: ["read", "fork"] }), undefined],
	] as const) {
		const { proc, lines } = fakeProc({ onRequest: (c, reply) => reply(c.type === "get_state" ? { sessionId: "WRONG" } : {}) });
		const handle = startForkChild(spec(proc));
		act(proc); setImmediate(() => proc.exit(1));
		const outcome = await handle.done;
		assert.equal(outcome.status, "failed", name);
		if (code) assert.equal(outcome.errorCode, code, name); else assert.equal(outcome.errorCode, "CONFIG_CHANGED", "session identity checked next");
		assert.ok(!lines.some(l => l.type === "prompt"), `${name}: no prompt was sent`);
	}
});

test("cancel: abort + EOF, then TERM/KILL ladder; no real close keeps childClosed=false (never claims cleanup)", async () => {
	const { proc, lines } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc));
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	await handle.cancel();
	const outcome = await handle.done;
	assert.equal(outcome.status, "cancelled");
	assert.equal(outcome.childClosed, false);
	assert.deepEqual(proc.killed, ["SIGTERM", "SIGKILL"]);
	assert.ok(lines.some(l => l.type === "abort"));
	assert.equal(proc.stdin.destroyed || proc.stdin.writableEnded, true, "stdin EOF is the lifeline");
});

test("cancel followed by a real close is confirmed", async () => {
	const { proc } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc, { closeGraceMs: 1000 }));
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	await handle.cancel(); setImmediate(() => proc.exit(0));
	const outcome = await handle.done;
	assert.equal(outcome.status, "cancelled"); assert.equal(outcome.childClosed, true); assert.deepEqual(proc.killed, []);
});

test("a model error in the child is a failure, not a success", async () => {
	const { proc } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc));
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	proc.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider down" } }) + "\n");
	await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	const outcome = await handle.done;
	assert.equal(outcome.status, "failed"); assert.equal(outcome.errorCode, "CHILD_MODEL_ERROR"); assert.match(outcome.error!, /provider down/);
});

test("oversized or garbage stdout lines are discarded without breaking the stream", async () => {
	const { proc } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc));
	proc.stdout.write("not json at all\n" + "{".padEnd(5 * 1024 * 1024, "x") + "\n");
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	assert.equal((await handle.done).status, "completed");
});

test("onMessage receives user/assistant/toolResult messages only after the task was sent (never earlier history)", async () => {
	const seen: any[] = [];
	const state = { n: 0 };
	const script = happyScript(state);
	const { proc } = fakeProc({ onRequest(cmd, reply) {
		script.onRequest(cmd, reply);
		if (cmd.type === "prompt") for (const message of [{ role: "user", content: "PROMPT" }, { role: "assistant", content: [{ type: "text", text: "hi" }] }, { role: "toolResult", toolCallId: "c", content: "r" }])
			proc.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
	} });
	const handle = startForkChild(spec(proc, { onMessage: message => { seen.push(message); throw new Error("a throwing sink must not break the stream"); } }));
	proc.stdout.write(JSON.stringify({ type: "message_end", message: { role: "user", content: "inherited history" } }) + "\n");
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	assert.equal((await handle.done).status, "completed");
	assert.deepEqual(seen.map(m => m.role), ["user", "assistant", "toolResult"]);
	assert.equal(seen[0].content, "PROMPT");
});

test("onEvent receives streaming and tool events only after the task was sent; a throwing sink never breaks the stream", async () => {
	const seen: string[] = [], script = happyScript({ n: 0 });
	const { proc } = fakeProc({ onRequest(cmd, reply) {
		script.onRequest(cmd, reply);
		if (cmd.type === "prompt") for (const event of [{ type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_update", message: { role: "assistant", content: [] } }, { type: "tool_execution_start", toolCallId: "c" }, { type: "tool_execution_end", toolCallId: "c", isError: false }, { type: "agent_end" }])
			proc.stdout.write(JSON.stringify(event) + "\n");
	} });
	const handle = startForkChild(spec(proc, { onEvent: (event: any) => { seen.push(event.type); throw new Error("sink failure is isolated"); } }));
	proc.stdout.write(JSON.stringify({ type: "message_update", message: { role: "user", content: "inherited" } }) + "\n");
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	assert.equal((await handle.done).status, "completed");
	assert.deepEqual(seen, ["message_start", "message_update", "tool_execution_start", "tool_execution_end"]);
});

test("fork_message: follow_up and steer reuse the existing RPC pipe and return the child disposition", async () => {
	const seen: Array<[string, string]> = [], state = { n: 0 }, script = happyScript(state);
	const { proc } = fakeProc({ onRequest(cmd, reply) {
		if (cmd.type === "follow_up" || cmd.type === "steer") { seen.push([cmd.type, cmd.message]); reply({ disposition: cmd.type === "follow_up" ? "queued" : "handled" }); return; }
		script.onRequest(cmd, reply);
	} });
	const handle = startForkChild(spec(proc));
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	assert.equal(await handle.steer("CONTROL-A", "follow_up"), "queued");
	assert.equal(await handle.steer("CONTROL-B", "steer"), "handled");
	assert.deepEqual(seen, [["follow_up", "CONTROL-A"], ["steer", "CONTROL-B"]]);
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	assert.equal((await handle.done).status, "completed");
});

test("fork_message before the child started, or after its transport closed, is a coded refusal", async () => {
	const { proc } = fakeProc(happyScript({ n: 0 }));
	const handle = startForkChild(spec(proc));
	await assert.rejects(() => handle.steer("EARLY", "follow_up"), /CHILD_NOT_READY/);
	ipc(proc, { type: "verified", tools: ["read"] });
	await new Promise(r => setImmediate(r));
	ipc(proc, { type: "settled", quiet: true }); setImmediate(() => proc.exit(0));
	await handle.done;
	await assert.rejects(() => handle.steer("LATE", "follow_up"), /RPC_CLOSED/);
});
