import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { applyPatch } from "diff";
import {
  createDiffFeedback,
  DIFF_TIMEOUT_MS,
  DIFF_WORKER_OLD_GENERATION_MB,
  type DiffRunnerTestOptions,
} from "../../src/diff-runner.js";
import { FileToolError } from "../../src/errors.js";
import { editTextFile, sha256 } from "../../src/file-operations.js";

// This script must be launched by the independent parent watchdog, never imported
// into the test runner: a regression to synchronous diff can hang its event loop.
const [scenario, directory] = process.argv.slice(2);
const fixtureUrl = new URL("./diff-behavior-worker.mjs", import.meta.url);

async function expectError(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof FileToolError);
    assert.equal(error.payload.code, code);
    assert.equal(error.payload.path, "fixture.txt");
    return true;
  });
}

async function lifecycle() {
  const workers: Worker[] = [];
  const baselineTimers = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const optionsFor = (behavior: string, extra: Record<string, unknown> = {}): DiffRunnerTestOptions => ({
    workerFactory(url, options) {
      assert.equal(url.href, new URL("../../src/diff-worker.mjs", import.meta.url).href);
      assert.equal(options.resourceLimits?.maxOldGenerationSizeMb, DIFF_WORKER_OLD_GENERATION_MB);
      assert.deepEqual(options.execArgv, []);
      const worker = new Worker(fixtureUrl, {
        ...options,
        workerData: { ...options.workerData, behavior, ...extra },
      });
      workers.push(worker);
      return worker;
    },
  });
  const assertClean = (signal?: AbortSignal) => {
    for (const worker of workers) {
      assert.equal(worker.threadId, -1, "promise must settle only after its worker exits");
      for (const event of ["message", "messageerror", "error", "exit"]) {
        assert.equal(worker.listenerCount(event), 0, `leaked worker ${event} listener`);
      }
    }
    if (signal) assert.equal(getEventListeners(signal, "abort").length, 0, "leaked abort listener");
    assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, baselineTimers, "leaked parent timer");
  };
  const runError = async (options: DiffRunnerTestOptions, code: string) => {
    const controller = new AbortController();
    await expectError(() => createDiffFeedback("old", "new", "fixture.txt", controller.signal, options), code);
    assertClean(controller.signal);
  };

  await runError({ workerFactory() { throw new Error("constructor failed"); } }, "IO_ERROR");
  await runError({
    workerFactory(_url, options) {
      const worker = new Worker(new URL("./diff-does-not-exist.mjs", import.meta.url), options);
      workers.push(worker);
      return worker;
    },
  }, "IO_ERROR");
  // Deserialization failures are difficult to produce with plain cloned strings;
  // inject the transport event on a real worker and still require actual teardown.
  const communicationOptions = optionsFor("busy");
  await runError({
    workerFactory(url, options) {
      const worker = communicationOptions.workerFactory!(url, options);
      queueMicrotask(() => worker.emit("messageerror", new Error("injected deserialize failure")));
      return worker;
    },
  }, "IO_ERROR");
  for (const behavior of ["exit-zero", "exit-nonzero", "throw"]) {
    await runError(optionsFor(behavior), "IO_ERROR");
  }
  await runError(optionsFor("resource-error"), "RESULT_TOO_LARGE");
  for (const message of [
    undefined, null, [], "bad", {}, { type: "ready" },
    { type: "result", diff: "", patch: 3 },
    { type: "result", diff: [], patch: "" },
    { type: "result", diff: "", patch: "", firstChangedLine: 0 },
    { type: "result", diff: "", patch: "", firstChangedLine: 1.5 },
    { type: "result", diff: "", patch: "", firstChangedLine: NaN },
    { type: "result", diff: "", patch: "", firstChangedLine: 99 },
    { type: "error", code: "NOT_A_CODE" },
  ]) {
    await runError(optionsFor("invalid", { message }), "IO_ERROR");
  }
  await runError(optionsFor("invalid", { message: { type: "error", code: "OPERATION_TIMEOUT" } }), "OPERATION_TIMEOUT");
  await runError(optionsFor("invalid", { message: { type: "error", code: "RESULT_TOO_LARGE" } }), "RESULT_TOO_LARGE");
  // Neither string alone exceeds the limit; their combined UTF-8 size does.
  await runError({ ...optionsFor("invalid", { message: { type: "result", diff: "😀", patch: "😀" } }), maxOutputBytes: 7 }, "RESULT_TOO_LARGE");

  for (const behavior of ["result-then-busy", "duplicate-result"]) {
    const controller = new AbortController();
    const result = await createDiffFeedback("old", "new", "fixture.txt", controller.signal, optionsFor(behavior));
    assert.deepEqual(result, { diff: "-1 old\n+1 new", patch: "test patch", firstChangedLine: 1 });
    assertClean(controller.signal);
  }

  // Cross abort/deadline only AFTER a successful message starts teardown. Gate
  // the real termination promise so the race is deterministic, not a timing guess.
  for (const failure of ["abort", "deadline"]) {
    const controller = new AbortController();
    let beginTeardown!: () => void;
    let releaseTeardown!: () => void;
    const begun = new Promise<void>((resolve) => { beginTeardown = resolve; });
    const release = new Promise<void>((resolve) => { releaseTeardown = resolve; });
    let sawResult = false;
    const delayed = optionsFor("result-then-busy");
    let completed = false;
    const expectation = expectError(() => createDiffFeedback("old", "new", "fixture.txt", controller.signal, {
      ...delayed,
      timeoutMs: 1_000,
      workerFactory(url, options) {
        const worker = delayed.workerFactory!(url, options);
        worker.once("message", (message) => { sawResult = message.type === "result"; });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = async () => {
          const exit = terminate();
          beginTeardown();
          await release;
          return exit;
        };
        return worker;
      },
    }), failure === "abort" ? "OPERATION_ABORTED" : "OPERATION_TIMEOUT").then(() => { completed = true; });
    try {
      await begun;
      assert.equal(sawResult, true, "test must cross the boundary after a successful result");
      if (failure === "abort") controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, 1_050));
      assert.equal(completed, false, "runner must await termination before settling");
    } finally {
      releaseTeardown();
      await expectation;
    }
    assertClean(controller.signal);
  }

  const beforeAborted = new AbortController();
  beforeAborted.abort();
  let invoked = false;
  await expectError(() => createDiffFeedback("old", "new", "fixture.txt", beforeAborted.signal, {
    workerFactory() { invoked = true; throw new Error("must not construct"); },
  }), "OPERATION_ABORTED");
  assert.equal(invoked, false);
  assertClean(beforeAborted.signal);

  // Covers an abort occurring between the initial signal check and listener setup.
  const constructionAbort = new AbortController();
  const constructionOptions = optionsFor("busy");
  await expectError(() => createDiffFeedback("old", "new", "fixture.txt", constructionAbort.signal, {
    workerFactory(url, options) {
      const worker = constructionOptions.workerFactory!(url, options);
      constructionAbort.abort();
      // Delivered after the runner attaches handlers and observes the abort, while
      // termination is pending: it must not escape as an unhandled 'error' event.
      queueMicrotask(() => worker.emit("error", new Error("late worker error")));
      return worker;
    },
  }), "OPERATION_ABORTED");
  assertClean(constructionAbort.signal);

  // Deadline starts before synchronous construction, not when 'online' arrives.
  const startupOptions = optionsFor("busy");
  await runError({
    timeoutMs: 30,
    workerFactory(url, options) {
      const worker = startupOptions.workerFactory!(url, options);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      return worker;
    },
  }, "OPERATION_TIMEOUT");

  // Use the real hard watchdog on a busy JS loop with no cooperative checks.
  const ready = new SharedArrayBuffer(4);
  const start = performance.now();
  await runError(optionsFor("busy", { ready }), "OPERATION_TIMEOUT");
  assert.equal(Atomics.load(new Int32Array(ready), 0), 1, "busy fixture actually started");
  assert.ok(performance.now() - start < DIFF_TIMEOUT_MS + 1_500);

  // Abort only once the fixture is inside its non-cooperative loop.
  const abortReady = new SharedArrayBuffer(4);
  const controller = new AbortController();
  const poll = setInterval(() => {
    if (Atomics.load(new Int32Array(abortReady), 0) === 1) controller.abort();
  }, 5);
  try {
    await expectError(() => createDiffFeedback("old", "new", "fixture.txt", controller.signal, optionsFor("busy", { ready: abortReady })), "OPERATION_ABORTED");
  } finally {
    clearInterval(poll);
  }
  assert.equal(controller.signal.aborted, true);
  assertClean(controller.signal);
  return { workersTerminated: workers.length };
}

async function regression(abort: boolean) {
  const path = join(directory, "regression.txt");
  const original = "a\n".repeat(15_000);
  const expected = "b\n".repeat(15_000);
  await writeFile(path, original, "utf8");
  const controller = new AbortController();
  const started = performance.now();
  let ticks = 0;
  let lastTick = started;
  let maxGap = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastTick);
    lastTick = now;
    ticks++;
  }, 10);
  const cancel = abort ? setTimeout(() => controller.abort(), 100) : undefined;
  let outcome: string;
  try {
    const result = await editTextFile(path, "regression.txt", [{ oldText: original, newText: expected }], sha256(original), controller.signal);
    assert.equal(abort, false, "the long-running regression must honor cancellation");
    assert.equal(applyPatch(original, result.patch), expected);
    assert.equal(await readFile(path, "utf8"), expected);
    outcome = "success";
  } catch (error) {
    assert.ok(error instanceof FileToolError);
    assert.equal(error.payload.code, abort ? "OPERATION_ABORTED" : "OPERATION_TIMEOUT");
    assert.deepEqual(await readFile(path), Buffer.from(original), "failed diff must leave the original bytes unchanged");
    outcome = error.payload.code;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(cancel);
  }
  maxGap = Math.max(maxGap, performance.now() - lastTick);
  assert.ok(ticks > 0, "event loop heartbeat must run while edit is pending");
  assert.ok(maxGap < 1_500, `main event loop stalled for ${maxGap}ms`);
  assert.ok(performance.now() - started < 6_000, "regression must not take the old 20+ seconds");
  return { outcome, ticks, maxGap, unchanged: (await readFile(path, "utf8")) === original };
}

let details: object;
if (scenario === "lifecycle") details = await lifecycle();
else if (scenario === "regression") details = await regression(false);
else if (scenario === "abort-regression") details = await regression(true);
else if (scenario === "different-cwd") {
  const result = await createDiffFeedback("old\n", "new\n", "path with spaces.txt");
  assert.equal(applyPatch("old\n", result.patch), "new\n");
  details = { cwd: process.cwd(), firstChangedLine: result.firstChangedLine };
} else throw new Error(`Unknown scenario: ${scenario}`);
console.log(JSON.stringify({ scenario, ok: true, ...details }));
// Deliberately no process.exit(): leaked referenced workers/timers prevent natural
// exit, which the independent parent's watchdog detects and forcefully cleans up.
