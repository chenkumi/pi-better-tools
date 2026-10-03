import { spawn, type IPty } from "node-pty";

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

	spawn(command: string, args: string[], options: SpawnOptions, defaultCwd: string): { sessionId: string; pid: number; target: string; transport: "local" | "wsl" | "ssh" } {
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
			dataWaiters: new Set(),
			exitWaiters: new Set(),
		};

		pty.onData((data) => {
			session.outputBuffer += data;
			this.notify(session.dataWaiters);
		});
		pty.onExit(({ exitCode, signal }) => {
			session.state = "exited";
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
			await this.waitForOutputOrExit(session, timeoutMs, signal);
		}
		return this.drainOutput(session);
	}

	resize(sessionId: string, cols: number, rows: number): void {
		this.requireSession(sessionId).pty.resize(cols, rows);
	}

	async waitForExit(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExitInfo> {
		const session = this.requireSession(sessionId);
		if (session.exitInfo) return session.exitInfo;

		const exited = await this.waitForExitOrTimeout(session, timeoutMs, signal);
		return exited ? (session.exitInfo ?? { exitCode: -1 }) : { exitCode: -1 };
	}

	kill(sessionId: string, signal = "SIGHUP"): void {
		const session = this.requireSession(sessionId);
		try {
			session.pty.kill(process.platform === "win32" ? undefined : signal);
		} catch {
			// A process which has already exited has nothing left to terminate.
		}
		session.state = "exited";
		session.exitInfo ??= { exitCode: -1 };
		this.notify(session.dataWaiters);
		this.notify(session.exitWaiters);
		this.sessions.delete(sessionId);
	}

	list(): PtySessionSummary[] {
		return [...this.sessions.values()].map((session) => ({
			sessionId: session.id,
			pid: session.pid,
			target: session.target,
			transport: session.transport,
			state: session.state,
			bufferedBytes: Buffer.byteLength(session.outputBuffer),
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
		const output = session.outputBuffer;
		session.outputBuffer = "";
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
