import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forwardParentArgs } from "../src/args.ts";
import { CHANNEL } from "../src/child-guard.ts";
import { startForkChild, type ForkChildOutcome, type ForkChildSpec } from "../src/child.ts";
import { FORK_GUARD_ENV } from "../src/identity.ts";
import { acceptFork, deps, onSessionStart, onTurnEnd, state, MAX_RETAINED_FORKS } from "../src/manager.ts";
import { forksDir } from "../src/store.ts";

const KEY = Symbol.for("pi-better-tools.fork.registry.v1");
let root: string, cwd: string, sessions: string;
beforeEach(() => {
	delete (globalThis as any)[KEY];
	root = mkdtempSync(join(tmpdir(), "fork-review-"));
	cwd = realpathSync(root); sessions = join(cwd, "sessions");
	deps.argv = () => []; deps.launchCwd = () => cwd;
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); delete (globalThis as any)[KEY]; });

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function origin() {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fork", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(), usage } as never);
	sm.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "fork", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } as never);
	return sm;
}
function fakes(sm: SessionManager) {
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, hasUI: false, sessionManager: sm };
	const pi: any = { getActiveTools: () => ["read", "fork"], getAllTools: () => ["read", "fork"].map(name => ({ name, sourceInfo: { path: `/ext/${name}.ts` } })), getThinkingLevel: () => "off", sendMessage: () => {} };
	return { ctx, pi };
}

test("G1-002: undelivered results cannot grow the retained window without bound", async () => {
	const a = fakes(origin()), b = fakes(SessionManager.create(cwd, join(cwd, "other")));
	const finishers: Array<(o: Partial<ForkChildOutcome>) => void> = [];
	deps.startChild = (() => {
		let resolve!: (o: ForkChildOutcome) => void; const done = new Promise<ForkChildOutcome>(r => { resolve = r; });
		finishers.push(o => resolve({ status: "completed", output: "R", childClosed: true, stderrTail: "", ...o }));
		return { pid: 1, done, async cancel() {} };
	}) as never;
	onSessionStart(b.pi, b.ctx); // the user switched away: results of origin A stay pending
	let admitted = 0, refused: string | undefined;
	for (let i = 0; i < MAX_RETAINED_FORKS * 2 + 1; i++) {
		try { acceptFork(a.pi, a.ctx, { task: `t${i}` }); } catch (error) { refused = String((error as Error).message); break; }
		admitted++;
		onTurnEnd(a.ctx, {});
		finishers.at(-1)!({});
		await new Promise(r => setImmediate(r));
	}
	assert.ok(state().jobs.size <= MAX_RETAINED_FORKS * 2, `retained ${state().jobs.size}`);
	assert.match(refused ?? "", /FORK_CAPACITY/);
	assert.ok(admitted <= MAX_RETAINED_FORKS * 2);
});

test("G1-003: a failed second prompt write removes the first owned prompt file (and spares the foreign path)", () => {
	const jobId = "01TESTJOB0000000000000000A";
	const name = (flag: string) => `${jobId}.${createHash("sha256").update(flag).digest("hex").slice(0, 8)}.prompt.txt`;
	mkdirSync(forksDir(cwd), { recursive: true });
	const squatter = join(forksDir(cwd), name("--append-system-prompt"));
	mkdirSync(squatter); // a foreign entry owns the second target name, so the exclusive create fails with EEXIST
	assert.throws(() => forwardParentArgs(["--system-prompt", "FIRST inline", "--append-system-prompt", "SECOND inline"], cwd, jobId, cwd));
	assert.deepEqual(readdirSync(forksDir(cwd)), [name("--append-system-prompt")], "the first prompt file is gone; the foreign entry is untouched");
	assert.ok(existsSync(squatter));
});

function fakeProc(script: { onRequest: (cmd: any, reply: (data?: unknown) => void) => void }) {
	const proc: any = new EventEmitter(); const lines: any[] = []; let buffer = "";
	proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.connected = true; proc.pid = undefined; proc.killed = [] as string[];
	proc.stdin = new Writable({ write(chunk, _enc, cb) {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const command = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); lines.push(command);
			script.onRequest(command, data => proc.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }) + "\n"));
		}
		cb();
	} });
	proc.send = (_m: any, cb?: () => void) => { cb?.(); return true; };
	proc.kill = (signal: string) => { proc.killed.push(signal); return true; };
	proc.exit = (code = 0) => proc.emit("close", code);
	return { proc, lines };
}

test("G1-004: a cancel accepted while get_session_stats is pending never publishes the initial prompt", async () => {
	let token = ""; let releaseStats: (() => void) | undefined;
	const { proc, lines } = fakeProc({ onRequest(cmd, reply) {
		if (cmd.type === "get_state") reply({ sessionId: "S1" });
		else if (cmd.type === "get_session_stats") releaseStats = () => reply({ tokens: { total: 1 }, cost: 0 });
		else reply({ disposition: "started" });
	} });
	const spec: ForkChildSpec = { jobId: "J", sessionId: "S1", sessionPath: "/nonexistent.jsonl", sessionDir: "/d", cwd: "/w", model: "p/m", thinkingLevel: "off", tools: ["read"], trusted: false, guardPath: "/g.ts", forwarded: [], prompt: "PROMPT",
		invocation: () => ({ command: "pi", args: [] }), spawnImpl: ((_c: string, _a: string[], options: any) => { token = JSON.parse(options.env[FORK_GUARD_ENV]).token; return proc; }) as never, closeGraceMs: 5, killGraceMs: 5 } as never;
	const handle = startForkChild(spec, () => {});
	proc.emit("message", { channel: CHANNEL, token, type: "verified", tools: ["read"] });
	while (!releaseStats) await new Promise(r => setImmediate(r));
	await handle.cancel();
	releaseStats();
	setTimeout(() => proc.exit(0), 20);
	const outcome = await handle.done;
	assert.equal(outcome.status, "cancelled");
	assert.equal(lines.some(line => line.type === "prompt"), false, `requests: ${lines.map(l => l.type).join(",")}`);
});
