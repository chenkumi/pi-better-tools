import { spawn, type IPty } from "node-pty";

/** Output buffer cap per session (UTF-16 code units, ~2 MiB of ASCII). Oldest output is dropped first. */
export const MAX_BUFFER_CHARS = 2 * 1024 * 1024;
export const MAX_SESSIONS = 16;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
export const MAX_WAIT_MS = 60_000;
/** Exited sessions are reclaimed this long after exit, even if never released. */
export const EXITED_RETENTION_MS = 10 * 60_000;
export const KILL_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGKILL"] as const;
export type KillSignal = (typeof KILL_SIGNALS)[number];

export interface KillResult {
	sessionId: string;
	/** True only when the local transport has exited and the session was released. */
	released: boolean;
	exited: boolean;
	signal: string;
	escalatedToSigkill: boolean;
	/** Local transport only; a remote process tree is never confirmed stopped. */
	note: string;
}

export interface ManagerOptions {
	maxSessions?: number;
	maxBufferChars?: number;
	exitedRetentionMs?: number;
	/** Wait after each kill attempt (initial signal, then SIGKILL escalation). */
	killWaitMs?: number;
	now?: () => number;
}

function checkSize(value: number | undefined, max: number, label: string): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer between 1 and ${max}`);
}

export type SessionState = "running" | "exited";

export interface ExitInfo {
	exitCode: number;
	signal?: number;
}

export interface PtySessionSummary {
	sessionId: string;
	/** Local PTY/transport PID, not a remote process PID. */
	pid: number;
	target: string;
	transport: "local" | "wsl" | "ssh";
	state: SessionState;
	bufferedBytes: number;
	/** Characters dropped from the ring buffer and not yet reported by pty_read. */
	droppedChars: number;
}

interface PtySession {
	id: string;
	/** Local PTY/transport PID, not a remote process PID. */
	pid: number;
	target: string;
	transport: "local" | "wsl" | "ssh";
	pty: IPty;
	state: SessionState;
	outputBuffer: string;
	droppedChars: number;
	exitedAt?: number;
	exitInfo?: ExitInfo;
	dataWaiters: Set<() => void>;
	exitWaiters: Set<() => void>;
}

export interface SpawnOptions {
	target?: string;
	transport?: "local" | "wsl" | "ssh";
	cwd?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("PTY operation aborted");
}

/**
 * Owns PTY processes for one Pi extension session. Reads drain pending output,
 * so a chunk is never returned twice by consecutive reads.
 */
export class PtySessionManager {
	private readonly sessions = new Map<string, PtySession>();
	private nextId = 0;
	private readonly maxSessions: number;
	private readonly maxBufferChars: number;
	private readonly retentionMs: number;
	private readonly killWaitMs: number;
	private readonly now: () => number;

	constructor(options: ManagerOptions = {}) {
		this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
		this.maxBufferChars = options.maxBufferChars ?? MAX_BUFFER_CHARS;
		this.retentionMs = options.exitedRetentionMs ?? EXITED_RETENTION_MS;
		this.killWaitMs = options.killWaitMs ?? 2_000;
		this.now = options.now ?? Date.now;
	}

	/** Drop exited sessions past retention; if still at capacity, drop the oldest exited ones. */
	/** Free native handles of an exited session being forgotten (node-pty keeps them until kill()). */
	private dispose(id: string): void {
		const session = this.sessions.get(id);
		this.sessions.delete(id);
		try { session?.pty.kill(process.platform === "win32" ? undefined : "SIGHUP"); } catch { /* already gone */ }
	}

	private reclaim(needSlot = false): void {
		const now = this.now();
		for (const [id, session] of this.sessions) {
			if (session.state === "exited" && session.exitedAt !== undefined && now - session.exitedAt >= this.retentionMs) this.dispose(id);
		}
		if (needSlot) {
			for (const [id, session] of this.sessions) {
				if (this.sessions.size < this.maxSessions) break;
				if (session.state === "exited") this.dispose(id);
			}
		}
	}

	spawn(command: string, args: string[], options: SpawnOptions, defaultCwd: string): { sessionId: string; pid: number; target: string; transport: "local" | "wsl" | "ssh" } {
		checkSize(options.cols, MAX_COLS, "cols");
		checkSize(options.rows, MAX_ROWS, "rows");
		this.reclaim(true);
		if (this.sessions.size >= this.maxSessions) throw new Error(`PTY session limit reached (${this.maxSessions}); kill an existing session first`);
		const pty = spawn(command, args, {
			name: "xterm-256color",
			cols: options.cols ?? 100,
			rows: options.rows ?? 30,
			cwd: options.cwd ?? defaultCwd,
			env: {
				...(process.env as Record<string, string>),
				TERM: "xterm-256color",
				...(options.env ?? {}),
			},
		});

		const id = `pty-${process.pid}-${++this.nextId}`;
		const session: PtySession = {
			id,
			pid: pty.pid,
			target: options.target ?? "local",
			transport: options.transport ?? "local",
			pty,
			state: "running",
			outputBuffer: "",
			droppedChars: 0,
			dataWaiters: new Set(),
			exitWaiters: new Set(),
		};

		pty.onData((data) => {
			session.outputBuffer += data;
			if (session.outputBuffer.length > this.maxBufferChars) {
				const overflow = session.outputBuffer.length - this.maxBufferChars;
				session.droppedChars += overflow;
				session.outputBuffer = session.outputBuffer.slice(overflow).replace(/^[\uDC00-\uDFFF]/, "");
			}
			this.notify(session.dataWaiters);
		});
		pty.onExit(({ exitCode, signal }) => {
			session.state = "exited";
			session.exitedAt = this.now();
			session.exitInfo = { exitCode, signal };
			this.notify(session.exitWaiters);
			this.notify(session.dataWaiters);
		});

		this.sessions.set(id, session);
		return { sessionId: id, pid: pty.pid, target: session.target, transport: session.transport };
	}

	write(sessionId: string, data: string): void {
		this.requireSession(sessionId).pty.write(data);
	}

	async read(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
		const session = this.requireSession(sessionId);
		if (session.outputBuffer.length === 0 && session.state === "running") {
			await this.waitForOutputOrExit(session, Math.min(timeoutMs, MAX_WAIT_MS), signal);
		}
		return this.drainOutput(session);
	}

	resize(sessionId: string, cols: number, rows: number): void {
		checkSize(cols, MAX_COLS, "cols");
		checkSize(rows, MAX_ROWS, "rows");
		this.requireSession(sessionId).pty.resize(cols, rows);
	}

	async waitForExit(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExitInfo> {
		const session = this.requireSession(sessionId);
		if (session.exitInfo) return session.exitInfo;

		const exited = await this.waitForExitOrTimeout(session, Math.min(timeoutMs, MAX_WAIT_MS), signal);
		return exited ? (session.exitInfo ?? { exitCode: -1 }) : { exitCode: -1 };
	}

	/**
	 * Sends a whitelisted signal (ignored on Windows, where node-pty has no POSIX signals), waits briefly,
	 * escalates to SIGKILL on POSIX, and releases the session only once the local transport has exited.
	 * A failed or unconfirmed kill keeps the session so it can be retried and reached by shutdown.
	 * Exit of the local transport does not prove a remote/WSL process tree stopped.
	 */
	async kill(sessionId: string, signal: string = "SIGHUP"): Promise<KillResult> {
		if (!(KILL_SIGNALS as readonly string[]).includes(signal)) throw new Error(`Unsupported signal ${signal}; allowed: ${KILL_SIGNALS.join(", ")}`);
		const session = this.requireSession(sessionId);
		const windows = process.platform === "win32";
		const note = "Only the local PTY transport is tracked; remote/WSL process-tree termination is not confirmed.";
		let escalated = false;
		const result = (released: boolean): KillResult => ({ sessionId, released, exited: session.state === "exited", signal: windows ? "n/a (Windows)" : signal, escalatedToSigkill: escalated, note });
		if (session.state === "running") {
			try {
				session.pty.kill(windows ? undefined : signal);
			} catch (error) {
				if (session.state === "running") throw new Error(`PTY kill failed; session ${sessionId} retained: ${error instanceof Error ? error.message : String(error)}`);
			}
			await this.waitForExitOrTimeout(session, this.killWaitMs);
			if (session.state === "running" && !windows && signal !== "SIGKILL") {
				escalated = true;
				try { session.pty.kill("SIGKILL"); } catch { /* reported below if still running */ }
				await this.waitForExitOrTimeout(session, this.killWaitMs);
			}
		}
		if (session.state !== "exited") return result(false);
		this.dispose(sessionId); // also frees node-pty native handles, which keep the host alive on Windows
		return result(true);
	}

	list(): PtySessionSummary[] {
		this.reclaim();
		return [...this.sessions.values()].map((session) => ({
			sessionId: session.id,
			pid: session.pid,
			target: session.target,
			transport: session.transport,
			state: session.state,
			bufferedBytes: Buffer.byteLength(session.outputBuffer),
			droppedChars: session.droppedChars,
		}));
	}

	shutdown(): void {
		for (const session of this.sessions.values()) {
			try {
				session.pty.kill(process.platform === "win32" ? undefined : "SIGHUP");
			} catch {
				// The OS has already reaped this child.
			}
			session.state = "exited";
			session.exitedAt ??= this.now();
			session.exitInfo ??= { exitCode: -1 };
			this.notify(session.dataWaiters);
			this.notify(session.exitWaiters);
		}
		this.sessions.clear();
	}

	private requireSession(sessionId: string): PtySession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Unknown PTY session: ${sessionId}`);
		return session;
	}

	private drainOutput(session: PtySession): string {
		const notice = session.droppedChars > 0 ? `[pty-terminal: ${session.droppedChars} earlier characters were dropped because output was not read fast enough]\n` : "";
		const output = notice + session.outputBuffer;
		session.outputBuffer = "";
		session.droppedChars = 0;
		return output;
	}

	private notify(waiters: Set<() => void>): void {
		for (const notify of waiters) notify();
		waiters.clear();
	}

	private waitForOutputOrExit(session: PtySession, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		return this.waitFor(session, timeoutMs, signal, session.dataWaiters, session.exitWaiters);
	}

	private async waitForExitOrTimeout(session: PtySession, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		let exited = false;
		await this.waitFor(session, timeoutMs, signal, undefined, session.exitWaiters, () => {
			exited = true;
		});
		return exited || session.exitInfo !== undefined;
	}

	private waitFor(
		session: PtySession,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		dataWaiters: Set<() => void> | undefined,
		exitWaiters: Set<() => void> | undefined,
		onExit?: () => void,
	): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError(signal));

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				dataWaiters?.delete(onData);
				exitWaiters?.delete(onExitWaiter);
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onData = (): void => finish();
			const onExitWaiter = (): void => {
				onExit?.();
				finish();
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				dataWaiters?.delete(onData);
				exitWaiters?.delete(onExitWaiter);
				signal?.removeEventListener("abort", onAbort);
				reject(abortError(signal!));
			};
			const timer = setTimeout(finish, timeoutMs);

			dataWaiters?.add(onData);
			exitWaiters?.add(onExitWaiter);
			signal?.addEventListener("abort", onAbort, { once: true });

			if ((dataWaiters && session.outputBuffer.length > 0) || session.exitInfo) {
				if (session.exitInfo) onExit?.();
				finish();
			}
		});
	}
}
