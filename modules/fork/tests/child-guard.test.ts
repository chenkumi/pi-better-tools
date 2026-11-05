import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test, { mock } from "node:test";
import guard, { CHANNEL, POLL_MS } from "../src/child-guard.ts";
import { FORK_GUARD_ENV, FORK_MARKER_TYPE } from "../src/identity.ts";
import { publishCapability } from "../../../shared/src/background/index.ts";

const SLOT = Symbol.for("pi-better-tools.fork.child-guard.v1"), LOADED = Symbol.for("pi-better-tools.fork.child-guard.loaded.v1");
const cwd = realpathSync(mkdtempSync(`${tmpdir()}/fork-guard-`));
const base = { forkId: "F", sessionId: "S1", parentSessionId: "PARENT", cwd, model: "p/m", thinkingLevel: "off", childTrusted: false, tools: ["read"], token: "tok" };

function harness(over: Partial<typeof base> & { loadable?: string[] } = {}, ctxOver: Record<string, unknown> = {}, active = ["read"]) {
	delete (globalThis as any)[SLOT]; delete (globalThis as any)[LOADED];
	process.env[FORK_GUARD_ENV] = JSON.stringify({ ...base, ...over });
	const handlers = new Map<string, Function>(); const sent: any[] = [];
	Object.defineProperty(process, "connected", { value: true, configurable: true });
	(process as any).send = (m: unknown, cb?: () => void) => { sent.push(m); cb?.(); return true; };
	const exits: number[] = []; const realExit = process.exit; process.exit = ((code: number) => { exits.push(code); }) as never;
	const pi: any = { on: (n: string, h: Function) => handlers.set(n, h), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getThinkingLevel: () => "off" };
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
	const withFork = harness({ tools: ["read", "fork", "fork_status"] }, {}, ["read", "fork", "fork_status"]); try {
		withFork.handlers.get("session_start")!({ reason: "startup" }, withFork.ctx);
		assert.equal(withFork.sent.at(-1).type, "verified", "the child keeps the parent's Fork tools active");
		assert.deepEqual(withFork.sent.at(-1).tools, ["fork", "fork_status", "read"]);
	} finally { withFork.restore(); }
	const cases: Array<[string, Partial<typeof base>, Record<string, unknown>, string[]?]> = [
		["MODEL_UNAVAILABLE", { model: "p/other" }, {}],
		["CONFIG_CHANGED", { sessionId: "OTHER" }, {}],
		["CONFIG_CHANGED", { thinkingLevel: "high" }, {}],
		["TRUST_REQUIRED", { childTrusted: true }, {}],
		["FORK_ORIGIN_MISSING", {}, { sessionManager: { getSessionId: () => "S1", getSessionFile: () => "/f", getEntries: () => [] } }],
		["CAPABILITY_MISMATCH", { tools: ["read", "bash"] }, {}],
		["CAPABILITY_MISMATCH", {}, {}, ["read", "bash"]],
		["CAPABILITY_MISMATCH", {}, {}, ["read", "fork"]], // a Fork tool the parent did not select is as foreign as any other
		["CAPABILITY_MISMATCH", { tools: ["read", "fork"] }, {}], // and a parent Fork tool the child lost would break the cached prefix
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
		for (const toolName of ["fork", "fork_status", "fork_cancel", "fork_message"]) assert.equal(h.handlers.get("tool_call")!({ toolName }).block, true);
	} finally { h.restore(); }
});

test("every provider request carries the parent's session id as its cache identity", () => {
	const h = harness(); try {
		// Pi gives this hook an empty header set (its provider adds defaults afterwards), so the identity must be written, not patched.
		const empty: Record<string, string> = {};
		h.handlers.get("before_provider_headers")!({ headers: empty });
		assert.deepEqual(empty, { session_id: "PARENT", "x-client-request-id": "PARENT" });
		const opencode: Record<string, string> = { "x-opencode-session": "S1", "x-opencode-client": "pi" };
		h.handlers.get("before_provider_headers")!({ headers: opencode });
		assert.equal(opencode["x-opencode-session"], "PARENT");
		assert.equal(opencode["x-opencode-client"], "pi", "unrelated headers are untouched");
		const payload = { model: "m", prompt_cache_key: "S1" };
		assert.deepEqual(h.handlers.get("before_provider_request")!({ payload }), { model: "m", prompt_cache_key: "PARENT" });
		assert.equal(payload.prompt_cache_key, "S1", "the original payload is not mutated");
		assert.equal(h.handlers.get("before_provider_request")!({ payload: { model: "m" } }), undefined, "providers without a cache key are left alone");
	} finally { h.restore(); }
	const noParent = harness({ parentSessionId: "" }); try {
		assert.equal(noParent.handlers.has("before_provider_headers"), false);
		assert.equal(noParent.handlers.has("before_provider_request"), false);
	} finally { noParent.restore(); }
});

test("deferred tools named in --tools (so they register) are deactivated again; only those names, anything else still rejects", () => {
	const ok = harness({ tools: ["read"], loadable: ["sqlite_query"] }, {}, ["read", "sqlite_query"]); try {
		ok.handlers.get("session_start")!({ reason: "startup" }, ok.ctx);
		assert.equal(ok.sent.at(-1).type, "verified"); assert.deepEqual(ok.sent.at(-1).tools, ["read"]);
	} finally { ok.restore(); }
	const foreign = harness({ tools: ["read"], loadable: ["sqlite_query"] }, {}, ["read", "sqlite_query", "bash"]); try {
		try { foreign.handlers.get("session_start")!({ reason: "startup" }, foreign.ctx); } catch { /* exit stub */ }
		assert.equal(foreign.sent.at(-1).code, "CAPABILITY_MISMATCH");
	} finally { foreign.restore(); }
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
