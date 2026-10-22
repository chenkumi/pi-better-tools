import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeJobCounts, canonicalMonitorCwd } from "../../shell-tools/src/monitor-capability.ts";
import { FORK_MARKER_TYPE, consumeForkChildGuard, hasForkMarker, isForkTool } from "./identity.ts";

export const CHANNEL = "pi-fork";
export const POLL_MS = 1000;
const LOADED = Symbol.for("pi-better-tools.fork.child-guard.loaded.v1");

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
			const active = pi.getActiveTools();
			if (model !== expected.model) code = "MODEL_UNAVAILABLE";
			else if (fs.realpathSync(ctx.cwd) !== expected.cwd || ctx.sessionManager.getSessionId() !== expected.sessionId || pi.getThinkingLevel() !== expected.thinkingLevel) code = "CONFIG_CHANGED";
			else if (ctx.isProjectTrusted() !== expected.childTrusted) code = "TRUST_REQUIRED";
			else if (!hasForkMarker(ctx.sessionManager.getEntries())) code = "FORK_ORIGIN_MISSING";
			else if (active.some(name => !isForkTool(name) && !expected.tools.includes(name)) || expected.tools.some(name => !active.includes(name))) code = "CAPABILITY_MISMATCH";
			else if (active.some(isForkTool)) code = "FORK_TOOL_ACTIVE";
			if (!code) send({ type: "verified", tools: [...active].sort(), sessionFile: ctx.sessionManager.getSessionFile() });
		} catch { code = "CONFIG_CHANGED"; }
		if (code) reject(code);
	});
	pi.on("tool_call", event => isForkTool(event.toolName) ?{ block: true, reason: "FORK_FORBIDDEN: A Fork process cannot create another Fork." } : undefined);
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
