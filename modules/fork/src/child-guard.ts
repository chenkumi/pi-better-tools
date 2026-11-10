import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeJobCounts, canonicalMonitorCwd } from "../../../shared/src/background/index.ts";
import { FORK_CHILD_REFUSAL, FORK_MARKER_TYPE, consumeForkChildGuard, hasForkMarker, isForkTool } from "./identity.ts";

export const CHANNEL = "pi-fork";
export const POLL_MS = 1000;
const LOADED = Symbol.for("pi-better-tools.fork.child-guard.loaded.v1");
/** Session-affinity header names Pi 1.5.2 derives from the session id, per provider API (the compat flags then pick among them). An API not listed gets all of them. */
const AFFINITY_BY_API: Record<string, readonly string[]> = {
	"openai-codex-responses": ["session-id", "x-client-request-id"],
	"openai-responses": ["session-id", "x-session-id", "x-client-request-id"],
	"openai-completions": ["session_id", "x-session-id", "x-session-affinity", "x-client-request-id"],
	"anthropic-messages": ["x-session-affinity", "x-session-id"],
};
const ALL_AFFINITY_HEADERS = ["session_id", "session-id", "x-session-id", "x-session-affinity", "x-client-request-id"] as const;

/** Loaded by `-e` in the Fork child only. Verifies the startup contract before the parent may send the first prompt,
 *  and reports settlement together with the child's own unfinished Shell/Subagent job counts over private IPC.
 *  This is a configuration guard, not an OS sandbox. */
export default function (pi: ExtensionAPI) {
	const expected = consumeForkChildGuard();
	if (!expected) return;
	const slot = globalThis as unknown as Record<symbol, boolean>;
	if (slot[LOADED]) return; // package entry and explicit -e may both load; one guard per process
	slot[LOADED] = true;
	const send = (message: Record<string, unknown>) => {
		if (!process.send || !process.connected) return;
		try { process.send({ channel: CHANNEL, token: expected.token, ...message }, () => {}); } catch { /* IPC loss is handled by the parent's close/deadline path */ }
	};
	const reject = (code: string): never => {
		send({ type: "rejected", code });
		try { fs.writeSync(2, `${code}: Fork child startup configuration rejected before provider request\n`); } catch { /* diagnostics only */ }
		process.exit(1);
		throw new Error(code);
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	let current: ExtensionContext | undefined;
	const stopPolling = () => { if (timer) clearInterval(timer); timer = undefined; };
	/** This child session's own unfinished Shell/Subagent jobs. Throws when the session cannot be read. */
	const pendingJobs = (ctx: ExtensionContext): { shell: number; subagents: number } => {
		const counts = activeJobCounts({ sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) });
		return { shell: counts.shell, subagents: counts.subagents };
	};
	/** True when the process is idle with nothing queued and no unfinished Shell/Subagent jobs of its own. */
	const quiet = (): boolean => {
		const ctx = current; if (!ctx) return false;
		try {
			const pending = pendingJobs(ctx);
			return ctx.isIdle() && !ctx.hasPendingMessages() && pending.shell + pending.subagents === 0;
		} catch { return false; }
	};
	const settle = () => send({ type: "settled", quiet: true });
	/** The session is the authority on whether the model call failed; no counter stands in for it.
	 *  Only entries written after this Fork's own origin marker count: the inherited snapshot ends with the parent's
	 *  fork call, so an earlier assistant error belongs to the parent and must not be reported as this Fork's. */
	const modelError = (ctx: ExtensionContext): string | undefined => {
		try {
			const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, any>>;
			let from = 0;
			for (let i = 0; i < entries.length; i++) if (entries[i]?.type === "custom" && entries[i]?.customType === FORK_MARKER_TYPE) from = i + 1;
			for (let i = entries.length - 1; i >= from; i--) {
				const message = entries[i]?.type === "message" ? entries[i]!.message : undefined;
				if (message?.role !== "assistant") continue;
				if (message.stopReason !== "error") return undefined;
				return typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage.slice(0, 300) : "assistant stopped with error";
			}
		} catch { /* unreadable session: report nothing rather than guess */ }
		return undefined;
	};
	/** Report a fatal model error immediately, even while unfinished jobs keep the session from being quiet.
	 *  A Fork whose own model call failed cannot make progress by itself; staying silent until those jobs end hides
	 *  that from the parent. This is a truth report only: it never settles, and never claims success. */
	let blockedSignature: string | undefined;
	const reportBlocked = (ctx: ExtensionContext): void => {
		let pending: { shell: number; subagents: number };
		try { pending = pendingJobs(ctx); } catch { return; }
		const failure = modelError(ctx);
		if (!failure || pending.shell + pending.subagents === 0) {
			// Progress is possible again, or the ordinary quiet path already covers termination.
			if (blockedSignature !== undefined) { blockedSignature = undefined; send({ type: "unblocked" }); }
			return;
		}
		const signature = `${pending.shell}:${pending.subagents}:${failure}`;
		if (signature === blockedSignature) return;
		blockedSignature = signature;
		send({ type: "blocked", reason: "MODEL_ERROR", error: failure, pending });
	};
	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		let code: string | undefined;
		try {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			// Naming a deferred tool in `--tools` registers it but also activates it. Undo exactly those names; any other difference still rejects below.
			const loadable = new Set(expected.loadable ?? []);
			if (pi.getActiveTools().some(name => loadable.has(name))) pi.setActiveTools(pi.getActiveTools().filter(name => !loadable.has(name)));
			const active = pi.getActiveTools();
			if (model !== expected.model) code = "MODEL_UNAVAILABLE";
			else if (fs.realpathSync(ctx.cwd) !== expected.cwd || ctx.sessionManager.getSessionId() !== expected.sessionId || pi.getThinkingLevel() !== expected.thinkingLevel) code = "CONFIG_CHANGED";
			else if (ctx.isProjectTrusted() !== expected.childTrusted) code = "TRUST_REQUIRED";
			else if (!hasForkMarker(ctx.sessionManager.getEntries())) code = "FORK_ORIGIN_MISSING";
			else if (active.some(name => !expected.tools.includes(name)) || expected.tools.some(name => !active.includes(name))) code = "CAPABILITY_MISMATCH";
			if (!code) send({ type: "verified", tools: [...active].sort(), sessionFile: ctx.sessionManager.getSessionFile() });
		} catch { code = "CONFIG_CHANGED"; }
		if (code) reject(code);
	});
	// Provider cache identity: Pi derives the cache key and session-affinity headers from the session id, and a new id makes the
	// Fork's first request miss the parent's cache. Every request this process sends (first prompt, later turns, fork_message)
	// uses the parent's id. Headers are written rather than patched: Pi hands this hook an empty set and its provider adds defaults
	// afterwards, with hook headers merged last. Only a Fork child process loads this; a cold /resume of a Fork is an ordinary session.
	const cacheId = expected.parentSessionId;
	if (typeof cacheId === "string" && cacheId) {
		pi.on("before_provider_headers", (event, ctx) => {
			// Only the names the current API uses (Pi 1.5.2 sets them per API and compat flag; the hook cannot see the flag, so a name
			// the model's compat leaves out is still an ignored extra header, but names of other APIs are not sent).
			for (const name of AFFINITY_BY_API[(ctx?.model as { api?: string } | undefined)?.api ?? ""] ?? ALL_AFFINITY_HEADERS) event.headers[name] = cacheId;
			for (const name of Object.keys(event.headers)) if (name.toLowerCase() === "x-opencode-session") event.headers[name] = cacheId;
		});
		pi.on("before_provider_request", event => {
			const payload = event.payload as Record<string, unknown> | null;
			if (payload && typeof payload === "object" && "prompt_cache_key" in payload) return { ...payload, prompt_cache_key: cacheId };
			return undefined;
		});
	}
	pi.on("tool_call", event => isForkTool(event.toolName) ?{ block: true, reason: FORK_CHILD_REFUSAL } : undefined);
	let stable = 0;
	pi.on("agent_settled", (_event, ctx) => {
		current = ctx; stable = 0;
		reportBlocked(ctx);
		if (quiet()) { stopPolling(); settle(); return; }
		// Settled with unfinished nested jobs: a job's own wake-up re-enters agent_settled. When a job ends without waking the agent,
		// two consecutive quiet ticks (not one) rule out the window between "job finished" and "wake-up turn started".
		timer ??= setInterval(() => {
			const active = current;
			if (active) reportBlocked(active);
			if (!quiet()) { stable = 0; return; }
			if (++stable >= 2) { stopPolling(); settle(); }
		}, POLL_MS);
		timer.unref?.();
	});
	pi.on("session_shutdown", () => { stopPolling(); current = undefined; });
}
