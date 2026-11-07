/** Time source injected into the engine so tests never sleep. Handles are opaque. */
export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Longest delay a Node timer accepts; longer waits are re-armed by the engine. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS));
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
