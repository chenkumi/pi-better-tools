import { consumeManagedChildGuard } from "../../shell-tools/src/managed-child.ts";

/** Persisted in every Fork conversation so a cold /resume still knows its origin. Not an OS boundary. */
export const FORK_MARKER_TYPE = "pi-better-tools.fork-origin";
export const FORK_TOOLS = ["fork", "fork_status", "fork_cancel", "fork_message"] as const;
export const FORK_GUARD_ENV = "PI_FORK_GUARD";
const SLOT = Symbol.for("pi-better-tools.fork.child-guard.v1");

export interface ForkChildGuard {
	forkId: string;
	sessionId: string;
	cwd: string;
	model: string;
	thinkingLevel: string;
	childTrusted: boolean;
	tools: string[];
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
	if (consumeManagedChildGuard()) return "FORK_FORBIDDEN: Subagent processes cannot create a Fork.";
	if (consumeForkChildGuard()) return "FORK_FORBIDDEN: A Fork process cannot create another Fork.";
	if (hasForkMarker(entries)) return "FORK_FORBIDDEN: This conversation is itself a Fork and cannot create another Fork.";
	return undefined;
}
