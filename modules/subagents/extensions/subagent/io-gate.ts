/** Cancellable waiting is not cancellation of the underlying filesystem operation. */
export const SUBAGENT_IO_TIMEOUT_MS = 300_000;

export class IoGate {
	private readonly controller = new AbortController();
	private waiting = 0;
	private pending = 0;
	private readonly idleWaiters = new Set<() => void>();
	private readonly timeoutMs: number;
	onWaitingChange: (count: number) => void = () => {};

	constructor(timeoutMs = SUBAGENT_IO_TIMEOUT_MS) {
		this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : SUBAGENT_IO_TIMEOUT_MS;
	}
	get stopped(): boolean { return this.controller.signal.aborted; }
	get pendingOperations(): number { return this.pending; }
	/** Actual completion barrier, deliberately unaffected by stop()/waiting deadlines. */
	whenIdle(): Promise<void> {
		if (this.pending === 0) return Promise.resolve();
		return new Promise(resolve => { this.idleWaiters.add(resolve); });
	}
	private completed(): void {
		this.pending--;
		if (this.pending === 0) {
			for (const resolve of this.idleWaiters) resolve();
			this.idleWaiters.clear();
		}
	}
	stop(reason: Error): void { if (!this.stopped) this.controller.abort(reason); }
	private notify(): void { try { this.onWaitingChange(this.waiting); } catch { /* host callbacks must not escape */ } }

	run<T>(operation: () => Promise<T>, label: string): Promise<T> {
		if (this.stopped) return Promise.reject(this.controller.signal.reason);
		this.pending++;
		this.waiting++;
		this.notify();
		const actual = Promise.resolve().then(operation);
		return new Promise<T>((resolve, reject) => {
			let done = false;
			const finish = (ok: boolean, value: unknown) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.controller.signal.removeEventListener("abort", aborted);
				this.waiting--;
				this.notify();
				if (ok) resolve(value as T); else reject(value);
			};
			const aborted = () => finish(false, this.controller.signal.reason);
			const timer = setTimeout(() => this.stop(new Error(`Subagent logging I/O stalled for ${this.timeoutMs} ms (${label}).`)), this.timeoutMs);
			this.controller.signal.addEventListener("abort", aborted, { once: true });
			if (this.stopped) aborted();
			// Keep a rejection handler even after abort/timeout; never close/delete live I/O resources.
			actual.then((value) => { this.completed(); finish(true, value); }, (error) => { this.completed(); finish(false, error); });
		});
	}
}
