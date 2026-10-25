import { fork, type ChildProcess } from "node:child_process";
import type { ExecuteResult, QueryResult, SqlParams, SqliteManager, SqliteStatus } from "./sqlite-manager.js";

type Reply = { ready: true } | { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type OpenResult = { success: boolean; message: string };
/** A child process together with the promise that settles when the OS reports it gone. */
type Host = { child: ChildProcess; ready: Promise<void>; exited: Promise<void>; reopened: boolean };

const CHILD_HEAP_MB = 256;
const NOT_OPEN = "No database is currently open. Use sqlite_open to open a database first.";
const DISPOSED_MESSAGE = "SQLite session has shut down; the session has ended and this tool can no longer be used. Start a new session.";
export const CANCELLED_MESSAGE = "The SQLite call was cancelled and its process was terminated. Whether a write completed is not confirmed; check the data before retrying.";

/**
 * The session's SQLite connection, kept in a child process: `node:sqlite` is synchronous, so a long statement would
 * otherwise freeze Pi, and only killing the process stops it. Calls run one at a time, in order. Cancelling a running
 * call kills the process and waits for it to exit before anything else starts; the next call then starts a new process
 * and reopens the same file (connection-local state such as temp tables is lost).
 */
export class SqliteClient {
  private host: Host | undefined;
  /** The host being killed: no replacement starts until the OS confirms it exited. */
  private exiting: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  /** The file the session has open; a restarted process reopens it before the next call. */
  private openPath: string | undefined;
  /** Set once the session is over: calls still waiting in the queue are refused instead of reopening a connection. */
  private disposed = false;

  open(filePath: string, signal?: AbortSignal): Promise<OpenResult> {
    return this.enqueue(async () => {
      // Nothing is closed or created for a call that was cancelled while it waited.
      if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
      this.openPath = undefined;
      await this.stop();
      if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
      const result = await this.send<OpenResult>("open", [filePath]);
      if (result.success) {
        this.openPath = filePath;
        this.host!.reopened = true;
      } else await this.stop();
      return result;
    }, signal);
  }

  close(signal?: AbortSignal): Promise<OpenResult> {
    return this.enqueue(async () => {
      if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
      if (!this.openPath) return { success: false, message: "No database is currently open." };
      const closedPath = this.openPath;
      this.openPath = undefined;
      const result = await this.send<OpenResult>("close", []).catch((error: Error) => ({ success: false, message: error.message }));
      await this.stop();
      return result.success ? { success: true, message: `Database closed: ${closedPath}` } : result;
    }, signal);
  }

  /** Ends the session's connection at once, without waiting for queued calls, and refuses every later one. Resolves once the process is gone. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.openPath = undefined;
    return this.stop().catch(() => undefined);
  }

  status(signal?: AbortSignal): Promise<SqliteStatus> {
    return this.enqueue(async () => this.openPath && !this.disposed ? await this.send<SqliteStatus>("status", []) : { isOpen: false, filePath: null, tables: null }, signal, true);
  }

  query(sql: string, params?: SqlParams, signal?: AbortSignal): Promise<QueryResult> {
    return this.call("query", [sql, params], signal);
  }

  execute(sql: string, params?: SqlParams, signal?: AbortSignal): Promise<ExecuteResult> {
    return this.call("execute", [sql, params], signal);
  }

  listTables(signal?: AbortSignal): Promise<{ tables: string[] }> {
    return this.call("listTables", [], signal);
  }

  describeTable(tableName: string, signal?: AbortSignal): Promise<ReturnType<SqliteManager["describeTable"]>> {
    return this.call("describeTable", [tableName], signal);
  }

  private call<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    return this.enqueue(async () => {
      if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
      if (!this.openPath) throw new Error(NOT_OPEN);
      return await this.send<T>(method, args, signal);
    }, signal);
  }

  /**
   * Runs `run` after every earlier call. A call cancelled while it still waits settles at once and is skipped on its turn;
   * once it runs, its own signal handling (killing the process) decides when it settles.
   */
  private enqueue<T>(run: () => Promise<T>, signal?: AbortSignal, allowDisposed = false): Promise<T> {
    let started = false;
    let onAbort: (() => void) | undefined;
    const task = new Promise<T>((resolve, reject) => {
      onAbort = () => { if (!started) reject(new Error(CANCELLED_MESSAGE)); };
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.then(async () => {
        if (signal?.aborted) { reject(new Error(CANCELLED_MESSAGE)); return; }
        if (this.disposed && !allowDisposed) { reject(new Error(DISPOSED_MESSAGE)); return; }
        started = true;
        try { resolve(await run()); } catch (error) { reject(error); }
      });
    });
    const settled = task.then(() => undefined, () => undefined);
    this.queue = settled;
    void settled.then(() => { if (onAbort) signal?.removeEventListener("abort", onAbort); });
    return task;
  }

  private async send<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    const host = await this.start();
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        // Only ending the process stops a statement that is already running; report only once it is gone.
        this.pending.delete(id);
        this.stop().then(() => reject(new Error(CANCELLED_MESSAGE)), (error: Error) => reject(error));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value as T); },
        reject: error => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      host.child.send({ id, method, args });
    });
  }

  /** Starts the process if needed (never while one is still exiting), and reopens the session's file after a restart. */
  private async start(): Promise<Host> {
    if (this.exiting) await this.exiting;
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
    const host = this.host ?? this.spawn();
    await host.ready;
    if (this.host !== host) throw new Error("The SQLite process was stopped.");
    if (this.openPath && !host.reopened) {
      const path = this.openPath;
      const result = await this.request<OpenResult>(host, "open", [path]);
      if (!result.success) {
        this.openPath = undefined;
        await this.stop();
        throw new Error(`The SQLite connection had to be restarted and ${path} could not be reopened: ${result.message}`);
      }
      host.reopened = true;
    }
    return host;
  }

  private spawn(): Host {
    const child = fork(new URL("./sqlite-process.mjs", import.meta.url), [], {
      execArgv: [`--max-old-space-size=${CHILD_HEAP_MB}`], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise<void>(resolve => child.once("close", () => { this.lost(host); resolve(); }));
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", (message: Reply) => {
        if ("ready" in message) { resolve(); return; }
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.ok) entry?.resolve(message.value); else entry?.reject(new Error(message.message));
      });
      child.once("error", error => reject(new Error(`The SQLite process failed: ${error.message}`)));
      void exited.then(() => reject(new Error("The SQLite process stopped before it was ready.")));
    });
    ready.catch(() => undefined);
    const host: Host = { child, ready, exited, reopened: false };
    this.host = host;
    return host;
  }

  private request<T>(host: Host, method: string, args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      host.child.send({ id, method, args });
    });
  }

  /** Kills the process, fails what it was running, and resolves only after the OS reports the exit. */
  private stop(): Promise<void> {
    const host = this.host;
    if (!host) return this.exiting ?? Promise.resolve();
    this.host = undefined;
    this.failAll("The SQLite process was stopped.");
    const exiting: Promise<void> = host.exited.then(() => { if (this.exiting === exiting) this.exiting = undefined; });
    this.exiting = exiting;
    if (!host.child.kill("SIGKILL") && host.child.exitCode === null && host.child.signalCode === null) {
      return Promise.reject(new Error("The SQLite process could not be terminated; its connection may still be running. Restart Pi if SQLite stays unresponsive."));
    }
    return exiting;
  }

  /** The process ended on its own (crash, killed from outside). */
  private lost(host: Host): void {
    if (this.host !== host) return;
    this.host = undefined;
    this.failAll("The SQLite process stopped unexpectedly.");
  }

  private failAll(message: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(new Error(message));
  }
}
