/** Process-wide FIFO permit pool. Per-call limits alone let parallel tool calls multiply the active child count. */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];
	constructor(permits: number) { this.available = Math.max(1, Math.floor(permits)); }
	get waiting(): number { return this.waiters.length; }
	get free(): number { return this.available; }
	/** Resolves with a one-shot release function, or undefined when the signal aborted while queued (no permit held). */
	async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
		if (signal?.aborted) return undefined;
		if (this.available > 0) { this.available--; return this.releaser(); }
		return new Promise((resolve) => {
			const onAbort = () => {
				const index = this.waiters.indexOf(grant);
				if (index >= 0) this.waiters.splice(index, 1);
				resolve(undefined);
			};
			const grant = () => { signal?.removeEventListener("abort", onAbort); resolve(this.releaser()); };
			this.waiters.push(grant);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) next(); else this.available++;
		};
	}
}

/** Best-effort process-tree termination. Windows POSIX signals only reach the direct child, so use taskkill /T there. */
export function killProcessTree(
	proc: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
	signal: NodeJS.Signals,
	deps: { platform?: NodeJS.Platform; spawn: (command: string, args: string[], options: { stdio: "ignore"; windowsHide: true }) => { on(event: "error", listener: () => void): unknown; unref?(): void } },
): void {
	if ((deps.platform ?? process.platform) === "win32" && typeof proc.pid === "number") {
		try {
			const killer = deps.spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			killer.on("error", () => { try { proc.kill(signal); } catch { /* already gone */ } });
			killer.unref?.();
		} catch { /* fall back to the direct child below */ }
	}
	try { proc.kill(signal); } catch { /* already gone */ }
}
