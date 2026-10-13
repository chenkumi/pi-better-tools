import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test, { mock } from "node:test";
import guard, { CHANNEL, POLL_MS } from "../src/child-guard.ts";
import { FORK_GUARD_ENV, FORK_MARKER_TYPE } from "../src/identity.ts";
import { publishCapability } from "../../shell-tools/src/monitor-capability.ts";

const SLOT = Symbol.for("pi-better-tools.fork.child-guard.v1"), LOADED = Symbol.for("pi-better-tools.fork.child-guard.loaded.v1");
const cwd = realpathSync(mkdtempSync(`${tmpdir()}/fork-guard-`));
const base = { forkId: "F", sessionId: "S1", cwd, model: "p/m", thinkingLevel: "off", childTrusted: false, tools: ["read"], token: "tok" };

function harness(over: Partial<typeof base> = {}, ctxOver: Record<string, unknown> = {}, active = ["read"]) {
	delete (globalThis as any)[SLOT]; delete (globalThis as any)[LOADED];
	process.env[FORK_GUARD_ENV] = JSON.stringify({ ...base, ...over });
	const handlers = new Map<string, Function>(); const sent: any[] = [];
	Object.defineProperty(process, "connected", { value: true, configurable: true });
	(process as any).send = (m: unknown, cb?: () => void) => { sent.push(m); cb?.(); return true; };
	const exits: number[] = []; const realExit = process.exit; process.exit = ((code: number) => { exits.push(code); }) as never;
	const pi: any = { on: (n: string, h: Function) => handlers.set(n, h), getActiveTools: () => active, getThinkingLevel: () => "off" };
	guard(pi);
	const state = { idle: true, pending: false };
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, isIdle: () => state.idle, hasPendingMessages: () => state.pending,
		sessionManager: { getSessionId: () => "S1", getSessionFile: () => "/f.jsonl", getEntries: () => [{ type: "custom", customType: FORK_MARKER_TYPE }] }, ...ctxOver };
	return { handlers, sent, exits, ctx, state, restore: () => { process.exit = realExit; delete (process as any).send; } };
}

test("verified startup is reported; each mismatch is rejected before any prompt could be sent", async () => {
	const ok = harness(); try {
		ok.handlers.get("session_start")!({ reason: "startup" }, ok.ctx);
		assert.deepEqual(ok.sent.map(m => [m.channel, m.token, m.type]), [[CHANNEL, "tok", "verified"]]);
		assert.deepEqual(ok.sent[0].tools, ["read"]);
		assert.equal(ok.exits.length, 0);
	} finally { ok.restore(); }
	const cases: Array<[string, Partial<typeof base>, Record<string, unknown>, string[]?]> = [
		["MODEL_UNAVAILABLE", { model: "p/other" }, {}],
		["CONFIG_CHANGED", { sessionId: "OTHER" }, {}],
		["CONFIG_CHANGED", { thinkingLevel: "high" }, {}],
		["TRUST_REQUIRED", { childTrusted: true }, {}],
		["FORK_ORIGIN_MISSING", {}, { sessionManager: { getSessionId: () => "S1", getSessionFile: () => "/f", getEntries: () => [] } }],
		["CAPABILITY_MISMATCH", { tools: ["read", "bash"] }, {}],
		["CAPABILITY_MISMATCH", {}, {}, ["read", "bash"]],
		["FORK_TOOL_ACTIVE", {}, {}, ["read", "fork"]],
	];
	for (const [code, over, ctxOver, active] of cases) {
		const h = harness(over, ctxOver, active); try {
			try { h.handlers.get("session_start")!({ reason: "startup" }, h.ctx); } catch { /* guard throws after exit stub returns */ }
			assert.equal(h.sent.at(-1).type, "rejected"); assert.equal(h.sent.at(-1).code, code); assert.deepEqual(h.exits, [1]);
		} finally { h.restore(); }
	}
});

test("Fork tool calls are blocked even if a stray extension re-adds them", () => {
	const h = harness(); try {
		assert.equal(h.handlers.get("tool_call")!({ toolName: "read" }), undefined);
		for (const toolName of ["fork", "fork_status", "fork_cancel"]) assert.equal(h.handlers.get("tool_call")!({ toolName }).block, true);
	} finally { h.restore(); }
});

test("settlement is reported when quiet; with nested jobs it waits for two consecutive quiet ticks", () => {
	const quiet = harness(); try {
		quiet.handlers.get("session_start")!({ reason: "startup" }, quiet.ctx); quiet.sent.length = 0;
		quiet.handlers.get("agent_settled")!({}, quiet.ctx);
		assert.deepEqual(quiet.sent.map(m => m.type), ["settled"]);
	} finally { quiet.restore(); }
	mock.timers.enable({ apis: ["setInterval"] });
	const h = harness(); let jobs = 1;
	const revoke = publishCapability("subagent_job", { sessionId: "S1", cwd }, 1, () => ({}), () => true, () => jobs);
	try {
		h.handlers.get("session_start")!({ reason: "startup" }, h.ctx); h.sent.length = 0;
		h.handlers.get("agent_settled")!({}, h.ctx);
		assert.equal(h.sent.length, 0, "nested subagent job unfinished: not settled");
		mock.timers.tick(POLL_MS); assert.equal(h.sent.length, 0);
		jobs = 0; h.state.idle = false; // job finished and its wake-up turn already started
		mock.timers.tick(POLL_MS); assert.equal(h.sent.length, 0, "not idle: still working");
		h.state.idle = true;
		mock.timers.tick(POLL_MS); assert.equal(h.sent.length, 0, "first quiet tick is not enough");
		mock.timers.tick(POLL_MS); assert.deepEqual(h.sent.map(m => m.type), ["settled"]);
		mock.timers.tick(POLL_MS * 3); assert.equal(h.sent.length, 1, "polling stopped after settling");
		h.handlers.get("session_shutdown")!();
	} finally { revoke(); h.restore(); mock.timers.reset(); rmSync(cwd, { recursive: true, force: true }); }
});
