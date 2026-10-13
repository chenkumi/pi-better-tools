import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeJobCounts, canonicalMonitorCwd } from "../../shell-tools/src/monitor-capability.ts";
import { FORK_TOOLS, consumeForkChildGuard, hasForkMarker } from "./identity.ts";

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
	/** True when the process is idle with nothing queued and no unfinished Shell/Subagent jobs of its own. */
	const quiet = (): boolean => {
		const ctx = current; if (!ctx) return false;
		try {
			const counts = activeJobCounts({ sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) });
			return ctx.isIdle() && !ctx.hasPendingMessages() && counts.shell + counts.subagents === 0;
		} catch { return false; }
	};
	const settle = () => send({ type: "settled", quiet: true });
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
			else if (active.some(name => !(FORK_TOOLS as readonly string[]).includes(name) && !expected.tools.includes(name)) || expected.tools.some(name => !active.includes(name))) code = "CAPABILITY_MISMATCH";
			else if (active.some(name => (FORK_TOOLS as readonly string[]).includes(name))) code = "FORK_TOOL_ACTIVE";
			if (!code) send({ type: "verified", tools: [...active].sort(), sessionFile: ctx.sessionManager.getSessionFile() });
		} catch { code = "CONFIG_CHANGED"; }
		if (code) reject(code);
	});
	pi.on("tool_call", event => (FORK_TOOLS as readonly string[]).includes(event.toolName) ? { block: true, reason: "FORK_FORBIDDEN: A Fork process cannot create another Fork." } : undefined);
	let stable = 0;
	pi.on("agent_settled", (_event, ctx) => {
		current = ctx; stable = 0;
		if (quiet()) { stopPolling(); settle(); return; }
		// Settled with unfinished nested jobs: a job's own wake-up re-enters agent_settled. When a job ends without waking the agent,
		// two consecutive quiet ticks (not one) rule out the window between "job finished" and "wake-up turn started".
		timer ??= setInterval(() => {
			if (!quiet()) { stable = 0; return; }
			if (++stable >= 2) { stopPolling(); settle(); }
		}, POLL_MS);
		timer.unref?.();
	});
	pi.on("session_shutdown", () => { stopPolling(); current = undefined; });
}
