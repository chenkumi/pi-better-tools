import { consumeManagedChildGuard } from "../../../../shared/src/background/index.ts";

/** Persisted in every Spinoff conversation so a cold /resume still knows its origin. Not an OS boundary. */
export const SPINOFF_MARKER_TYPE = "pi-better-tools.spinoff-origin";
import { SPINOFF_TOOLS } from "../../../../shared/src/contracts/index.ts";
export { SPINOFF_TOOLS };
export const isSpinoffTool = (name: string) => (SPINOFF_TOOLS as readonly string[]).includes(name);
/** The `spinoff` call inside a Spinoff child (execute and tool_call guard), and an agent_* call that addresses a Spinoff, fails with this. */
export const SPINOFF_CHILD_REFUSAL = "SPINOFF_FORBIDDEN: A Spinoff process cannot create another Spinoff or manage Spinoffs. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
export const SPINOFF_GUARD_ENV = "PI_SPINOFF_GUARD";
const SLOT = Symbol.for("pi-better-tools.spinoff.child-guard.v1");

export interface SpinoffChildGuard {
	spinoffId: string;
	sessionId: string;
	/** The originating session. The child sends it as its provider cache identity so its first request continues the parent's cache. */
	parentSessionId: string;
	cwd: string;
	model: string;
	thinkingLevel: string;
	childTrusted: boolean;
	tools: string[];
	/** Deferred tools the parent has registered but not activated. Pi activates every name in `--tools`, so the child deactivates these at start. */
	loadable?: string[];
	token: string;
}

/** Consume once per process: tools spawned later (including nested Pi) must not inherit the handshake. */
export function consumeSpinoffChildGuard(): SpinoffChildGuard | undefined {
	const slot = globalThis as unknown as Record<symbol, SpinoffChildGuard | undefined>;
	const encoded = process.env[SPINOFF_GUARD_ENV];
	if (encoded) {
		delete process.env[SPINOFF_GUARD_ENV];
		try { slot[SLOT] = JSON.parse(encoded) as SpinoffChildGuard; } catch { /* malformed handshake: stay a root process, guard rejects at start */ }
	}
	return slot[SLOT];
}

export function hasSpinoffMarker(entries: readonly { type?: string; customType?: string }[]): boolean {
	return entries.some(entry => entry.type === "custom" && entry.customType === SPINOFF_MARKER_TYPE);
}

/** Why this process/session may not create a Spinoff, or undefined for a root session. Reads trusted startup data only. */
export function spinoffCreationRefusal(entries: readonly { type?: string; customType?: string }[]): string | undefined {
	if (consumeManagedChildGuard()) return "SPINOFF_FORBIDDEN: Subagent processes cannot create a Spinoff. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
	if (consumeSpinoffChildGuard()) return "SPINOFF_FORBIDDEN: A Spinoff process cannot create another Spinoff. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
	if (hasSpinoffMarker(entries)) return "SPINOFF_FORBIDDEN: This conversation is itself a Spinoff and cannot create another Spinoff. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
	return undefined;
}
