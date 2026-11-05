import { consumeManagedChildGuard } from "../../../shared/src/background/index.ts";

/** Persisted in every Fork conversation so a cold /resume still knows its origin. Not an OS boundary. */
export const FORK_MARKER_TYPE = "pi-better-tools.fork-origin";
import { FORK_TOOLS } from "../../../shared/src/contracts/index.js";
export { FORK_TOOLS };
export const isForkTool = (name: string) => (FORK_TOOLS as readonly string[]).includes(name);
/** Every Fork tool call inside a Fork child (execute and tool_call guard) fails with this. */
export const FORK_CHILD_REFUSAL = "FORK_FORBIDDEN: A Fork process cannot create another Fork, or manage Forks. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
export const FORK_GUARD_ENV = "PI_FORK_GUARD";
const SLOT = Symbol.for("pi-better-tools.fork.child-guard.v1");

export interface ForkChildGuard {
	forkId: string;
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
export function consumeForkChildGuard(): ForkChildGuard | undefined {
	const slot = globalThis as unknown as Record<symbol, ForkChildGuard | undefined>;
	const encoded = process.env[FORK_GUARD_ENV];
	if (encoded) {
		delete process.env[FORK_GUARD_ENV];
		try { slot[SLOT] = JSON.parse(encoded) as ForkChildGuard; } catch { /* malformed handshake: stay a root process, guard rejects at start */ }
	}
	return slot[SLOT];
}

export function hasForkMarker(entries: readonly { type?: string; customType?: string }[]): boolean {
	return entries.some(entry => entry.type === "custom" && entry.customType === FORK_MARKER_TYPE);
}

/** Why this process/session may not create a Fork, or undefined for a root session. Reads trusted startup data only. */
export function forkCreationRefusal(entries: readonly { type?: string; customType?: string }[]): string | undefined {
	if (consumeManagedChildGuard()) return "FORK_FORBIDDEN: Subagent processes cannot create a Fork. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
	if (consumeForkChildGuard()) return "FORK_FORBIDDEN: A Fork process cannot create another Fork. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
	if (hasForkMarker(entries)) return "FORK_FORBIDDEN: This conversation is itself a Fork and cannot create another Fork. Do the task directly in this process, or use the subagent tool for a fresh-context worker.";
	return undefined;
}
