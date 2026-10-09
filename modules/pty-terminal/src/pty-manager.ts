import { createRequire } from "node:module";
import type { IPty, spawn } from "node-pty";
import { filterEnv, type EnvPolicy } from "./env.ts";
import { matchPattern, MATCH_BUDGET_MS } from "./matcher.ts";
import { stripEscapes, truncatePtyOutput, type OutputFormat } from "./output.ts";

/** node-pty is a native addon; load it on first spawn so Pi startup does not pay for it. */
const lazySpawn: typeof spawn = (...args) => (createRequire(import.meta.url)("node-pty") as typeof import("node-pty")).spawn(...args);

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
	/** Timer seam so waits can run on a fake clock in tests. Defaults to setTimeout/clearTimeout. */
	timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
	/** PTY factory seam (tests). Defaults to node-pty spawn. */
	spawnPty?: typeof spawn;
	/** Pure matcher seam for deterministic unit clocks; production uses an owned worker. */
	matchPattern?: typeof matchPattern;
}

/** Longest tail of unread output examined by waitFor, bounding regex cost. */
const MATCH_WINDOW_CHARS = 256 * 1024;
/** Minimum pause before re-running waitFor when new output arrived during a failed match. */
const MATCH_DEBOUNCE_MS = 50;

export interface DroppedRange { from: number; to: number }

export interface ReadOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Return as soon as the unread (ANSI-stripped) output matches. */
	waitFor?: RegExp;
	/** Return once no new output arrived for this long (after waitFor matched, if given). Bounded by timeoutMs. */
	settleMs?: number;
	/** Re-read buffered output from this cursor without consuming it. */
	since?: number;
	/** Output format of the caller; text format keeps waiting while only an incomplete escape sequence is buffered. */
	format?: OutputFormat;
}

export interface ReadSnapshot {
	text: string;
	/** Cursor of text[0]. */
	start: number;
	/** Cursor just after the last buffered character. */
	end: number;
	/** Output lost to the ring buffer that this read could not return. */
	dropped?: DroppedRange;
	/** Present when waitFor was requested. */
	wait?: "matched" | "timeout" | "exited";
	exited: boolean;
}

export function droppedNotice(range: DroppedRange): string {
	return `[pty-terminal: ${range.to - range.from} earlier characters were dropped (cursor ${range.from}-${range.to}); output exceeded the buffer]
`;
}

function checkSize(value: number | undefined, max: number, label: string): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer between 1 and ${max}`);
}

export type SessionState = "running" | "exited";

export interface ExitInfo {
	exitCode: number;
	signal?: number;
	/** True only when pty_wait_exit's own timeout expired (exitCode -1 is then a placeholder, not a real exit). */
	timedOut?: true;
	/** Present for SSH exit 255, which usually means a connection error rather than the remote command's code. */
	note?: string;
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
	/** Monotonic cursor just after the latest output. */
	cursor: number;
}

interface PtySession {
	id: string;
	/** Local PTY/transport PID, not a remote process PID. */
	pid: number;
	target: string;
	transport: "local" | "wsl" | "ssh";
	pty: IPty;
	state: SessionState;
	/** Retained output (read and unread); buffer[0] has cursor bufStart. Cursors count UTF-16 units and only grow. */
	buffer: string;
	bufStart: number;
	/** Cursor of the first unread character. */
	readPos: number;
	/** Unread output lost to the ring buffer, not yet reported. */
	drop?: DroppedRange;
	lastDataAt: number;
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
	/** Optional allow/deny filter for the inherited process.env (default: inherit everything). */
	envPolicy?: EnvPolicy;
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
	private closing = false;
	private readonly readAbort = new AbortController();
	private stopping?: Promise<{ retained: string[]; errors: string[] }>;
	private readonly matches = new Set<Promise<boolean>>();
	private readonly matcher: typeof matchPattern;
	private readonly maxSessions: number;
	private readonly maxBufferChars: number;
	private readonly retentionMs: number;
	private readonly killWaitMs: number;
	private readonly now: () => number;
	private readonly timers: NonNullable<ManagerOptions["timers"]>;
	private readonly spawnPty: typeof spawn;

	constructor(options: ManagerOptions = {}) {
		this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
		this.maxBufferChars = options.maxBufferChars ?? MAX_BUFFER_CHARS;
		this.retentionMs = options.exitedRetentionMs ?? EXITED_RETENTION_MS;
		this.killWaitMs = options.killWaitMs ?? 2_000;
		this.now = options.now ?? Date.now;
		this.timers = options.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as NodeJS.Timeout) };
		this.spawnPty = options.spawnPty ?? lazySpawn;
		this.matcher = options.matchPattern ?? matchPattern;
	}

	/** Reclamation never sacrifices unread output merely to admit a new session. */
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
				if (this.sessions.size < this.maxSessions) return;
				if (session.state !== "exited") continue;
				const unread = session.bufStart + session.buffer.length > session.readPos || session.drop !== undefined;
				if (!unread) this.dispose(id);
			}
		}
	}

	spawn(command: string, args: string[], options: SpawnOptions, defaultCwd: string): { sessionId: string; pid: number; target: string; transport: "local" | "wsl" | "ssh" } {
		if (this.closing) throw new Error("PTY manager is shutting down; new sessions are not admitted");
		checkSize(options.cols, MAX_COLS, "cols");
		checkSize(options.rows, MAX_ROWS, "rows");
		this.reclaim(true);
		if (this.sessions.size >= this.maxSessions) throw new Error(`PTY session limit reached (${this.maxSessions}); unread exited output is retained. Use pty_read to drain an exited session or pty_kill to explicitly release an existing session first`);
		const pty = this.spawnPty(command, args, {
			name: "xterm-256color",
			cols: options.cols ?? 100,
			rows: options.rows ?? 30,
			cwd: options.cwd ?? defaultCwd,
			env: {
				...filterEnv(process.env, options.envPolicy),
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
			buffer: "",
			bufStart: 0,
			readPos: 0,
			lastDataAt: this.now(),
			dataWaiters: new Set(),
			exitWaiters: new Set(),
		};

		pty.onData((data) => this.append(session, data));
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
		const session = this.requireSession(sessionId);
		if (session.state === "exited") {
			throw new Error(`PTY session ${sessionId} has exited${session.exitInfo ? ` (exitCode ${session.exitInfo.exitCode})` : ""}; input was not sent. Use pty_read to drain remaining output, pty_kill to release it, or pty_spawn a new session.`);
		}
		session.pty.write(data);
	}

	/** Appends output, advances the cursor and enforces the ring buffer (oldest output dropped first). */
	private append(session: PtySession, data: string): void {
		session.buffer += data;
		session.lastDataAt = this.now();
		if (session.buffer.length > this.maxBufferChars) {
			// Trim in batches: cut down to (max - slack) so a full buffer is copied once per `slack` characters instead of per chunk.
			// The retained size never exceeds the maximum; small test-sized buffers use no slack and stay exact.
			const slack = this.maxBufferChars >= 64 * 1024 ? Math.floor(this.maxBufferChars / 16) : 0;
			let overflow = session.buffer.length - (this.maxBufferChars - slack);
			if ((session.buffer.charCodeAt(overflow) & 0xfc00) === 0xdc00) overflow++; // do not start on a lone low surrogate
			session.buffer = session.buffer.slice(overflow);
			session.bufStart += overflow;
			if (session.bufStart > session.readPos) {
				session.drop = { from: session.drop?.from ?? session.readPos, to: session.bufStart };
				session.readPos = session.bufStart;
			}
		}
		this.notify(session.dataWaiters);
	}

	/** Drains pending output as one string (dropped-output notice first). Use readEx for cursors, waiting and re-reads. */
	async read(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
		const snapshot = await this.readEx(sessionId, { timeoutMs, signal });
		this.consume(sessionId, snapshot.end);
		return (snapshot.dropped ? droppedNotice(snapshot.dropped) : "") + snapshot.text;
	}

	/**
	 * Waits as requested, then returns a snapshot of buffered output WITHOUT consuming it; call consume() with the
	 * cursor actually delivered. Aborting only stops the wait: the session and its output are untouched.
	 */
	async readEx(sessionId: string, options: ReadOptions): Promise<ReadSnapshot> {
		const session = this.requireSession(sessionId);
		options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.readAbort.signal]) : this.readAbort.signal };
		if (options.signal?.aborted) throw abortError(options.signal);
		const end = () => session.bufStart + session.buffer.length;
		if (options.since !== undefined && (!Number.isInteger(options.since) || options.since < 0 || options.since > end())) {
			throw new Error(`since must be a cursor between 0 and ${end()} (the latest cursor); use a cursor from an earlier pty_read.`);
		}
		const from = options.since ?? session.readPos;
		const started = this.now();
		const timeout = Math.min(Math.max(options.timeoutMs, 0), MAX_WAIT_MS);
		const deadline = started + timeout;
		let wait: ReadSnapshot["wait"];
		if (options.waitFor) {
			const matched = await this.waitMatch(session, options.waitFor, from, deadline, options.signal);
			wait = matched ? "matched" : session.state === "exited" ? "exited" : "timeout";
			if (matched && options.settleMs) await this.waitSettle(session, options.settleMs, started, deadline, options.signal);
		} else if (options.settleMs) {
			await this.waitSettle(session, options.settleMs, started, deadline, options.signal);
		} else {
			// Default wait: until something deliverable is buffered. In text format an unfinished trailing escape sequence
			// is held back by truncatePtyOutput, so it does not count; keep waiting (bounded by the deadline) instead of returning empty.
			while (timeout > 0 && session.state === "running" && !this.deliverable(session, from, options.format)) {
				const remaining = deadline - this.now();
				if (remaining <= 0) break;
				await this.waitFor(session, remaining, options.signal, session.dataWaiters, session.exitWaiters);
			}
		}
		const begin = Math.max(from, session.bufStart);
		return {
			text: session.buffer.slice(begin - session.bufStart),
			start: begin,
			end: end(),
			dropped: options.since !== undefined ? (options.since < session.bufStart ? { from: options.since, to: session.bufStart } : undefined) : session.drop,
			wait,
			exited: session.state === "exited",
		};
	}

	/** True when unread output exists that a read in `format` would hand out (not merely an incomplete escape sequence held back). */
	private deliverable(session: PtySession, from: number, format: OutputFormat | undefined): boolean {
		const pending = session.buffer.slice(Math.max(from, session.bufStart) - session.bufStart);
		if (!pending) return false;
		if (format !== "text") return true;
		const held = truncatePtyOutput(pending, { format, final: false });
		return !(held.content === "" && held.remainder !== "");
	}

	/** Marks output up to `cursor` as delivered (the default read drains it) and clears the reported drop notice. */
	consume(sessionId: string, cursor: number): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.readPos = Math.max(session.readPos, Math.min(cursor, session.bufStart + session.buffer.length));
		session.drop = undefined;
	}

	/** Waits a fixed time (cut short if the process exits); abortable. */
	async pause(sessionId: string, ms: number, signal?: AbortSignal): Promise<void> {
		const session = this.requireSession(sessionId);
		await this.waitFor(session, Math.min(Math.max(ms, 0), MAX_WAIT_MS), signal, undefined, session.exitWaiters);
	}

	private async waitMatch(session: PtySession, pattern: RegExp, from: number, deadline: number, signal?: AbortSignal): Promise<boolean> {
		let retryAt = 0;
		for (;;) {
			if (retryAt !== 0 && deadline <= this.now()) return false;
			// Every failed attempt is throttled, including data arriving just after it finished.
			// Exit wakes the debounce early so final buffered output can still be examined.
			if (retryAt > this.now()) {
				await this.waitFor(session, Math.min(retryAt - this.now(), Math.max(0, deadline - this.now())), signal, undefined, session.exitWaiters);
				if (deadline <= this.now()) return false;
			}
			const begin = Math.max(from, session.bufStart);
			let window = session.buffer.slice(begin - session.bufStart);
			if (window.length > MATCH_WINDOW_CHARS) window = window.slice(-MATCH_WINDOW_CHARS);
			const generation = session.bufStart + session.buffer.length;
			const remainingBudget = deadline - this.now();
			const pending = this.matcher(pattern, stripEscapes(window), signal, remainingBudget > 0 ? remainingBudget : MATCH_BUDGET_MS);
			this.matches.add(pending);
			let matched: boolean;
			try { matched = await pending; }
			catch (error) {
				if (!signal?.aborted && remainingBudget > 0 && this.now() >= deadline && error instanceof Error && /worker budget/.test(error.message)) return false;
				throw error;
			} finally { this.matches.delete(pending); }
			if (matched) return true;
			retryAt = this.now() + MATCH_DEBOUNCE_MS;
			// Output may arrive while the worker is running; do not miss its notification.
			if (session.bufStart + session.buffer.length !== generation && deadline > this.now()) continue;
			const remaining = deadline - this.now();
			if (session.state === "exited" || remaining <= 0) return false;
			await this.waitFor(session, remaining, signal, session.dataWaiters, session.exitWaiters);
		}
	}

	private async waitSettle(session: PtySession, settleMs: number, started: number, deadline: number, signal?: AbortSignal): Promise<void> {
		for (;;) {
			const now = this.now();
			const quiet = now - Math.max(session.lastDataAt, started);
			if (session.state === "exited" || quiet >= settleMs || now >= deadline) return;
			await this.waitFor(session, Math.min(settleMs - quiet, deadline - now), signal, session.dataWaiters, session.exitWaiters);
		}
	}

	resize(sessionId: string, cols: number, rows: number): void {
		checkSize(cols, MAX_COLS, "cols");
		checkSize(rows, MAX_ROWS, "rows");
		this.requireSession(sessionId).pty.resize(cols, rows);
	}

	async waitForExit(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExitInfo> {
		const session = this.requireSession(sessionId);
		const annotate = (info: ExitInfo): ExitInfo => session.transport === "ssh" && info.exitCode === 255
			? { ...info, note: "SSH exit code 255 may indicate a connection error rather than the remote command's exit code; check pty_read output." }
			: info;
		if (session.exitInfo) return annotate(session.exitInfo);

		const exited = await this.waitForExitOrTimeout(session, Math.min(timeoutMs, MAX_WAIT_MS), signal);
		return exited ? annotate(session.exitInfo ?? { exitCode: -1 }) : { exitCode: -1, timedOut: true };
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
			bufferedBytes: Buffer.byteLength(session.buffer.slice(session.readPos - session.bufStart)),
			droppedChars: session.drop ? session.drop.to - session.drop.from : 0,
			cursor: session.bufStart + session.buffer.length,
		}));
	}

	shutdown(): Promise<{ retained: string[]; errors: string[] }> {
		if (this.stopping) return this.stopping;
		this.closing = true;
		this.readAbort.abort(new Error("PTY manager shutting down; session exit is not yet confirmed"));
		const work = (async () => {
			await Promise.allSettled([...this.matches]); // includes worker termination
			const errors: string[] = [];
			await Promise.all([...this.sessions.keys()].map(async id => {
				try {
					const result = await this.kill(id);
					if (!result.released) errors.push(`PTY ${id} termination unconfirmed; ownership retained`);
				} catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
			}));
			// No fabricated exit event or registry.clear(): only confirmed exits release ownership.
			return { retained: [...this.sessions.keys()], errors };
		})();
		this.stopping = work;
		void work.then(() => { if (this.stopping === work) this.stopping = undefined; });
		return work;
	}

	private requireSession(sessionId: string): PtySession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Unknown PTY session: ${sessionId}`);
		return session;
	}

	private notify(waiters: Set<() => void>): void {
		for (const notify of waiters) notify();
		waiters.clear();
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
		if (session.exitInfo) {
			onExit?.();
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				this.timers.clear(timer);
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
				this.timers.clear(timer);
				dataWaiters?.delete(onData);
				exitWaiters?.delete(onExitWaiter);
				signal?.removeEventListener("abort", onAbort);
				reject(abortError(signal!));
			};
			const timer = this.timers.set(finish, timeoutMs);

			dataWaiters?.add(onData);
			exitWaiters?.add(onExitWaiter);
			signal?.addEventListener("abort", onAbort, { once: true });

			if (session.exitInfo) {
				onExit?.();
				finish();
			}
		});
	}
}
