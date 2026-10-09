import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { type Worker } from "node:worker_threads";
import { MAX_QUEUED_VALIDATIONS, ValidationPool } from "../src/validation-pool.ts";

class FakeWorker extends EventEmitter {
  jobs: unknown[] = [];
  terminateCalls = 0;
  references = 0;
  stop?: { resolve: (value: number) => void; reject: (error: Error) => void };
  ref() { this.references++; }
  unref() { this.references--; }
  postMessage(job: unknown) { this.jobs.push(job); }
  terminate() {
    this.terminateCalls++;
    return new Promise<number>((resolve, reject) => { this.stop = { resolve, reject }; });
  }
  stopped() { this.emit("exit", 0); this.stop?.resolve(0); }
}
function fixture() {
  const workers: FakeWorker[] = [];
  const pool = new ValidationPool(() => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;
  });
  return { workers, pool, close: async () => {
    const pending = pool.close();
    for (const worker of workers) worker.stopped();
    await pending;
  } };
}

test("L32: reuses a ready worker and sends each schema/data without stale results", async () => {
  const f = fixture();
  try {
    const first = f.pool.validate({ type: "object" }, { a: 1 });
    f.workers[0].emit("message", { ready: true });
    f.workers[0].emit("message", {});
    assert.equal(await first, undefined);
    const second = f.pool.validate({ type: "object", required: ["b"] }, {});
    assert.equal(f.workers.length, 1);
    assert.deepEqual(f.workers[0].jobs, [
      { schema: { type: "object" }, data: { a: 1 } },
      { schema: { type: "object", required: ["b"] }, data: {} },
    ]);
    f.workers[0].emit("message", { reason: "b: required" });
    assert.equal(await second, "b: required");
  } finally { await f.close(); }
});

test("L32: FIFO bounded queue rejects overflow and removes cancelled waiters", async () => {
  const f = fixture();
  try {
    const active = Array.from({ length: 4 }, (_, i) => f.pool.validate({}, i));
    const cancel = new AbortController();
    const removed = f.pool.validate({}, "cancel", cancel.signal);
    const waiting = Array.from({ length: MAX_QUEUED_VALIDATIONS - 1 }, (_, i) => f.pool.validate({}, i + 4));
    assert.equal(f.workers.length, 4);
    assert.match((await f.pool.validate({}, "overflow"))!, /capacity exhausted/);
    cancel.abort(); assert.match((await removed)!, /cancelled/);
    const replacement = f.pool.validate({}, "replacement");
    for (const worker of f.workers) worker.emit("message", { ready: true });
    for (let i = 0; i < MAX_QUEUED_VALIDATIONS; i++) f.workers[0].emit("message", {});
    for (const worker of f.workers) worker.emit("message", {});
    for (const result of await Promise.all([...active, ...waiting, replacement])) assert.equal(result, undefined);
    assert.deepEqual(f.workers[0].jobs.map(job => (job as { data: unknown }).data), [0, ...Array.from({ length: 255 }, (_, i) => i + 4), "replacement"]);
    assert.equal(f.workers.length, 4);
  } finally { await f.close(); }
});

test("L32: cancellation holds capacity until confirmed exit, ignores late messages, and shutdown drains", async () => {
  const f = fixture();
  const cancel = new AbortController();
  const first = f.pool.validate({}, 0, cancel.signal);
  const others = Array.from({ length: 3 }, (_, i) => f.pool.validate({}, i + 1));
  const waiting = f.pool.validate({}, 4);
  cancel.abort();
  assert.equal(f.workers[0].terminateCalls, 1);
  f.workers[0].emit("message", { ready: true });
  f.workers[0].emit("message", {});
  assert.equal(f.workers.length, 4, "no replacement before termination");
  let settled = false; void first.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  f.workers[0].stopped();
  assert.match((await first)!, /cancelled/);
  assert.equal(f.workers.length, 5);
  f.workers[4].emit("message", { ready: true }); f.workers[4].emit("message", {});
  assert.equal(await waiting, undefined);
  const closing = f.pool.close();
  assert.match((await f.pool.validate({}, 99))!, /shutdown/);
  for (const worker of f.workers.slice(1)) worker.stopped();
  await closing;
  for (const reason of await Promise.all(others)) assert.match(reason!, /shutdown/);
  const next = f.pool.validate({}, "new session");
  f.workers.at(-1)!.emit("message", { ready: true }); f.workers.at(-1)!.emit("message", {});
  assert.equal(await next, undefined);
  await f.close();
});

test("L32: failed termination retains its permit until a late exit", async () => {
  const f = fixture();
  const cancel = new AbortController();
  const failed = f.pool.validate({}, 0, cancel.signal);
  const active = Array.from({ length: 3 }, (_, i) => f.pool.validate({}, i + 1));
  const queued = f.pool.validate({}, 4);
  try {
    cancel.abort();
    f.workers[0].stop!.reject(new Error("injected termination failure"));
    assert.match((await failed)!, /termination failed/);
    assert.equal(f.workers.length, 4, "failed termination must not free capacity");
    f.workers[0].emit("message", { ready: true });
    assert.equal(f.workers[0].jobs.length, 0, "retiring worker ignores late messages");
    f.workers[0].emit("exit", 1);
    assert.equal(f.workers.length, 5, "confirmed late exit releases capacity");
    f.workers[4].emit("message", { ready: true }); f.workers[4].emit("message", {});
    assert.equal(await queued, undefined);
    for (const worker of f.workers.slice(1, 4)) { worker.emit("message", { ready: true }); worker.emit("message", {}); }
    for (const result of await Promise.all(active)) assert.equal(result, undefined);
  } finally { await f.close(); }
});

test("L32: constructor failure fails closed without leaking a slot", async () => {
  let attempts = 0;
  const pool = new ValidationPool(() => { attempts++; throw new Error("injected constructor failure"); });
  for (let i = 0; i < 5; i++) assert.match((await pool.validate({}, {}))!, /constructor failure/);
  assert.equal(attempts, 5);
  await pool.close();
});

test("L32: worker errors and unexpected exits fail closed and recover capacity", async () => {
  const f = fixture();
  try {
    const failed = f.pool.validate({}, 1);
    f.workers[0].emit("error", new Error("injected error"));
    f.workers[0].stopped();
    assert.match((await failed)!, /injected error/);
    const exited = f.pool.validate({}, 2);
    f.workers[1].emit("exit", 1);
    assert.match((await exited)!, /without a result/);
    const valid = f.pool.validate({}, 3);
    f.workers[2].emit("message", { ready: true }); f.workers[2].emit("message", {});
    assert.equal(await valid, undefined);
  } finally { await f.close(); }
});
