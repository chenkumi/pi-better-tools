import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { buildManagedChildEnvironment, buildSubagentPiArgs } from "./child-args.ts";
import { RpcInteraction, type InteractionNotice, type QueryReceipt } from "./rpc.ts";
import { IoGate } from "./io-gate.ts";
import { killProcessTree } from "./concurrency.ts";
import { ManagedSession } from "./session-store.ts";

export interface ReadyQueryOptions {
  session: ManagedSession;
  snapshot: Buffer;
  queryId: string;
  question: string;
  signal: AbortSignal;
  invocation: (args: string[]) => { command: string; args: string[] };
  acquireChild: (signal: AbortSignal) => Promise<(() => void) | undefined>;
  ioTimeoutMs?: number;
  validate: () => Promise<void>;
  onInteractive: (handle: RpcInteraction) => void;
  onInteraction: (notice: InteractionNotice) => void;
  /** Internal filesystem seam for deterministic cleanup-failure probes. */
  removeTemporary?: (directory: string) => Promise<void>;
}

/** A disposable RPC process opens private copies only. It never prompts/steers
 * the task, and its query uses the same guarded child registry + query bridge as
 * live queries. Provider credentials are discovered by the child, never copied. */
export async function runReadyQuery(options: ReadyQueryOptions): Promise<QueryReceipt> {
  const { session, snapshot, queryId, signal } = options;
  const gate = new IoGate(options.ioTimeoutMs);
  let temporary: string | undefined, proc: ChildProcess | undefined, rpc: RpcInteraction | undefined;
  let released: (() => void) | undefined, exited: Promise<void> | undefined;
  let ending = false, closeCode: number | null = null, failure: Error | undefined;
  let result: InteractionNotice | undefined, published = false;
  let ioSettled = false, temporaryRemoved = false;
  let finishStdout = () => {};
  const receipt = (pending: boolean): InteractionNotice => {
    const notice: InteractionNotice = { ...(result ?? { usageUnknown: true, snapshotUnavailable: true }), kind: "query_result", queryId,
      status: failure && !failure.message.startsWith("QUERY_ABORTED:") ? "failed" : signal.aborted ? "aborted" : result?.status ?? "failed",
      cleanupPending: pending, cleanupEvidence: { childClosed: !proc || closeCode !== null, ioSettled, temporaryRemoved: !temporary || temporaryRemoved } };
    if (failure) notice.error = failure.message;
    if (notice.status !== "completed") delete notice.output;
    return notice;
  };
  let lastPublished = "";
  const publish = (notice: InteractionNotice) => {
    const encoded = JSON.stringify(notice);
    if (encoded === lastPublished) return;
    lastPublished = encoded; published = true;
    try { options.onInteraction(notice); } catch { /* observers do not own query settlement */ }
  };
  const pending = () => publish(receipt(true));
  const timers: ReturnType<typeof setTimeout>[] = [];
  const terminate = () => {
    if (!proc || ending) return;
    ending = true;
    rpc?.cancelQueries();
    // Keep draining IPC for terminal usage during orderly shutdown. Requesting
    // abort/kill is not a close acknowledgment; all ownership waits for close.
    void rpc?.pipe.end().catch(() => {});
    timers.push(setTimeout(() => {
      if (!proc || closeCode !== null) return;
      killProcessTree(proc, "SIGTERM", { spawn });
      timers.push(setTimeout(() => { if (proc && closeCode === null) killProcessTree(proc, "SIGKILL", { spawn }); }, 5000));
    }, 1000));
  };
  const abort = () => { failure ??= new Error("QUERY_ABORTED: owner cancelled query"); gate.stop(failure); terminate(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("QUERY_ABORTED: cancelled before query startup");
    released = await options.acquireChild(signal);
    await gate.run(options.validate, "validate ready query configuration");
    await gate.run(async () => { temporary = await fs.mkdtemp(join(tmpdir(), "pi-subagent-query-")); }, "create query copy directory");
    const clone = join(temporary!, "working.jsonl"), frozen = join(temporary!, "checkpoint.jsonl");
    const startupPath = join(temporary!, "startup.json"), promptPath = join(temporary!, "agent.txt");
    await gate.run(async () => {
      await fs.writeFile(clone, snapshot, { flag: "wx", mode: 0o600 });
      await fs.writeFile(frozen, snapshot, { flag: "wx", mode: 0o600 });
      await fs.writeFile(promptPath, session.manifest.config.agent.systemPrompt, { flag: "wx", mode: 0o600 });
    }, "write private query copies");
    const config = session.manifest.config, token = randomUUID();
    const args = buildSubagentPiArgs({ persistence: { kind: "resume", sessionDir: temporary!, sessionFile: clone },
      transport: "rpc", guardPath: fileURLToPath(new URL("./child-guard.ts", import.meta.url)), bridgePath: fileURLToPath(new URL("./child-bridge.ts", import.meta.url)),
      model: config.model, thinkingLevel: config.thinkingLevel, promptPath, taskPath: "" });
    args.push("--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates");
    const invocation = options.invocation(args);
    if (signal.aborted || gate.stopped) throw new Error("QUERY_ABORTED: cancelled before query spawn");
    proc = spawn(invocation.command, invocation.args, { cwd: config.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "ipc"], env: buildManagedChildEnvironment({
        id: session.id, cwd: config.cwd, model: config.model, thinkingLevel: config.thinkingLevel, childTrusted: config.childTrusted,
        startupPath, bridgeToken: token, readyQuerySnapshot: { path: frozen, hash: session.manifest.checkpoint!.nativeSha256, leafId: session.manifest.checkpoint!.leafId },
      }) });
    exited = new Promise<void>(resolve => {
      proc!.once("error", error => { failure ??= error; terminate(); pending(); });
      proc!.once("close", code => { closeCode = code ?? -1; finishStdout(); resolve(); });
    });
    let notifyQuery!: () => void;
    const queryReported = new Promise<void>(resolve => { notifyQuery = resolve; });
    rpc = new RpcInteraction(proc, token, config.model!, notice => {
      result = notice;
      // Deadline/unknown cleanup is observable immediately; successful replies
      // are published after actual query-process cleanup, not merely abort/EOF.
      if (notice.cleanupPending === true || published) pending();
      notifyQuery();
    });
    const decoder = new StringDecoder("utf8"); let buffer = "", stdoutFinished = false;
    const acceptLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "message_end" && ["user", "assistant", "toolResult"].includes(event.message?.role)) throw new Error("QUERY_MAINLINE_FORBIDDEN: disposable query must not run the delegated task");
      if (event.type === "extension_ui_request") throw new Error("QUERY_STARTUP_INTERACTION: query child requires interactive configuration");
      rpc!.pipe.accept(event);
    };
    const streamFailure = (error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); gate.stop(failure); terminate(); pending(); };
    finishStdout = () => {
      if (stdoutFinished) return;
      stdoutFinished = true;
      try { buffer += decoder.end(); acceptLine(buffer); buffer = ""; }
      catch (error) { streamFailure(error); }
    };
    proc.stdout!.on("end", finishStdout);
    proc.stdout!.on("data", chunk => {
      try {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error("RPC_CAPACITY: query stdout record exceeds 8 MiB");
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          acceptLine(line);
        }
      } catch (error) { streamFailure(error); }
    });
    // Continuously drain stderr without retaining secrets or unbounded output.
    proc.stderr!.on("data", () => {});
    const raceExit = async <T>(operation: Promise<T>): Promise<T> => Promise.race([operation,
      exited!.then(() => { throw failure ?? new Error(`QUERY_CHILD_EXITED: query child exited (${closeCode})`); })]);
    const assertProviderAdmission = () => {
      if (failure) throw failure;
      if (signal.aborted) throw new Error("QUERY_ABORTED: cancelled before provider request");
      if (ending || gate.stopped || closeCode !== null || stdoutFinished || !proc?.connected) throw new Error("QUERY_STARTUP_CLOSED: query worker is shutting down; provider request forbidden");
    };
    const state = await raceExit(rpc.pipe.request("get_state"));
    assertProviderAdmission();
    const startup = await gate.run(async () => JSON.parse(await fs.readFile(startupPath, "utf8")), "read query startup guard");
    if (startup.errorCode || startup.id !== session.id || startup.cwd !== config.cwd || startup.model !== config.model || startup.thinkingLevel !== config.thinkingLevel || startup.childTrusted !== config.childTrusted || state.sessionId !== session.id || state.sessionFile !== clone || `${state.model?.provider}/${state.model?.id}` !== config.model || state.thinkingLevel !== config.thinkingLevel) {
      throw new Error(`${startup.errorCode ?? "QUERY_CONFIG_CHANGED"}: query startup registry/trust/identity differs from saved configuration`);
    }
    await gate.run(options.validate, "recheck ready query configuration before provider request");
    assertProviderAdmission();
    rpc.start(); options.onInteractive(rpc);
    // The attachment callback may synchronously cancel the owner or close work.
    assertProviderAdmission();
    rpc.query(options.question, queryId);
    await raceExit(queryReported);
    await rpc.settled();
    // A child that ignores EOF cannot silently release its process permit/read
    // lease. Kill requests retain all resources until its real close event.
    timers.push(setTimeout(() => {
      if (closeCode === null) { failure ??= new Error("QUERY_CLEANUP_PENDING: query worker has not confirmed close"); terminate(); pending(); }
    }, 5000));
    await exited;
    if (failure) throw failure;
    if (closeCode !== 0) throw new Error(`QUERY_CHILD_EXITED: query child exited (${closeCode})`);
    if (!result) throw new Error("QUERY_NO_RESULT: no query result was observed");
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    terminate();
    // Notify known failure before waiting, but retain permits/copies until actual
    // process and filesystem completion. A completed model reply never masks it.
    if ((exited && closeCode === null) || gate.pendingOperations) pending();
    if (exited) await exited;
  } finally {
    signal.removeEventListener("abort", abort);
    timers.forEach(clearTimeout);
    rpc?.close(signal.aborted);
    await gate.whenIdle(); // Stop/deadline does not cancel filesystem writes.
    const cleanup = new IoGate(options.ioTimeoutMs);
    try {
      if (temporary) await cleanup.run(async () => {
        if (options.removeTemporary) await options.removeTemporary(temporary!);
        else await fs.rm(temporary!, { recursive: true, force: true });
        temporaryRemoved = true;
      }, "remove private query copies");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failure = new Error(failure ? `${failure.message}; cleanup failed: ${message}` : message);
      pending();
    } finally {
      await cleanup.whenIdle();
      ioSettled = true;
      released?.();
    }
  }
  const notice = receipt(!!proc && closeCode === null || !ioSettled || !!temporary && !temporaryRemoved);
  publish(notice);
  return Object.fromEntries(Object.entries(notice).filter(([key]) => key !== "kind")) as unknown as QueryReceipt;
}
