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

/**
 * Best-effort process-tree termination. Windows POSIX signals only reach the direct child, so use taskkill /T there.
 * On POSIX the child is spawned detached (its own process group), so the whole group is signalled via kill(-pid);
 * if that fails the direct child is signalled. Neither path proves the tree has stopped.
 */
export function killProcessTree(
	proc: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
	signal: NodeJS.Signals,
	deps: { platform?: NodeJS.Platform; killGroup?: (pid: number, signal: NodeJS.Signals) => void; spawn: (command: string, args: string[], options: { stdio: "ignore"; windowsHide: true }) => { on(event: "error", listener: () => void): unknown; unref?(): void } },
): void {
	if ((deps.platform ?? process.platform) === "win32" && typeof proc.pid === "number") {
		try {
			const killer = deps.spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			killer.on("error", () => { try { proc.kill(signal); } catch { /* already gone */ } });
			killer.unref?.();
		} catch { /* fall back to the direct child below */ }
	}
	else if (typeof proc.pid === "number" && proc.pid > 0 && (deps.platform ?? process.platform) !== "win32") {
		try { (deps.killGroup ?? ((pid, sig) => process.kill(-pid, sig)))(proc.pid, signal); return; }
		catch { /* no such group (not detached) or already gone: fall back to the direct child */ }
	}
	try { proc.kill(signal); } catch { /* already gone */ }
}
