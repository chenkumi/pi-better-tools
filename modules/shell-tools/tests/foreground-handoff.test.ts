import test from "node:test";
import assert from "node:assert/strict";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AUTO_BACKGROUND_MS, createForegroundHandoff, resolveAutoBackgroundMs } from "../src/foreground-handoff.js";
import { MAX_LOG_BYTES, TAIL_BYTES } from "../src/background-jobs.js";

test("auto background threshold defaults to 180s and accepts only a positive integer or 0", () => {
  assert.equal(DEFAULT_AUTO_BACKGROUND_MS, 300_000);
  assert.equal(resolveAutoBackgroundMs(undefined), 300_000);
  assert.equal(resolveAutoBackgroundMs({}), 300_000);
  assert.equal(resolveAutoBackgroundMs({ "pi-shell-tools": { autoBackgroundMs: 60_000 } }), 60_000);
  assert.equal(resolveAutoBackgroundMs({ "pi-shell-tools": { autoBackgroundMs: 0 } }), 0, "0 disables the safety net");
  for (const bad of [-1, 1.5, "60000", null, Number.NaN, 2_147_483_648]) assert.equal(resolveAutoBackgroundMs({ "pi-shell-tools": { autoBackgroundMs: bad } }), 300_000, String(bad));
});

function harness() {
  const handoff = createForegroundHandoff();
  const host: Buffer[] = [];
  let emit!: (data: Buffer) => void;
  const process: BashOperations = { exec: async (_c, _cwd, options) => { emit = options.onData; return { exitCode: 0 }; } };
  void handoff.wrap(process).exec("cmd", "/", { onData: data => host.push(data), signal: new AbortController().signal } as never);
  const jobSeen: Buffer[] = [];
  // Stand-in for ShellJobs' writer: records what the job sees and forwards a copy to the host like the real wrapper.
  const jobWrap = (operations: BashOperations): BashOperations => ({
    exec: (command, cwd, options) => operations.exec(command, cwd, { ...options, onData: data => { jobSeen.push(Buffer.from(data)); options.onData(data); } }),
  });
  return { handoff, host, jobSeen, jobWrap, emit: (data: string | Buffer) => emit(Buffer.from(data)) };
}

test("before attach, output goes to the host only", () => {
  const h = harness();
  h.emit("one\n"); h.emit("two\n");
  assert.equal(Buffer.concat(h.host).toString(), "one\ntwo\n");
  assert.equal(h.handoff.attached, false);
});

test("attach replays recorded output into the job once and routes later output there, forwarding it to the host a single time", () => {
  const h = harness();
  h.emit("early\n");
  h.handoff.attach(h.jobWrap, "/", new AbortController().signal);
  assert.equal(h.handoff.attached, true);
  assert.equal(Buffer.concat(h.jobSeen).toString(), "early\n", "job log receives the pre-handoff output");
  assert.equal(Buffer.concat(h.host).toString(), "early\n", "replay must not be forwarded to the host a second time");
  h.emit("late\n");
  assert.equal(Buffer.concat(h.jobSeen).toString(), "early\nlate\n");
  assert.equal(Buffer.concat(h.host).toString(), "early\nlate\n");
});

test("output beyond the retained head is replayed as its real tail window only", () => {
  const h = harness();
  const chunk = Buffer.alloc(64 * 1024, "a");
  for (let written = 0; written < MAX_LOG_BYTES + 256 * 1024; written += chunk.length) h.emit(chunk);
  h.emit("TAIL-MARKER\n");
  h.handoff.attach(h.jobWrap, "/", new AbortController().signal);
  const replayed = Buffer.concat(h.jobSeen);
  assert.ok(replayed.length <= MAX_LOG_BYTES + TAIL_BYTES, `replayed ${replayed.length} bytes`);
  assert.ok(replayed.subarray(-12).toString() === "TAIL-MARKER\n", "the most recent output survives the handoff");
  assert.ok(replayed.length > MAX_LOG_BYTES, "tail beyond the head is included");
});

test("attach fails closed if the job writer does not provide an output sink", () => {
  const h = harness();
  assert.throws(() => h.handoff.attach(() => ({ exec: async () => ({ exitCode: 0 }) }), "/", new AbortController().signal), /did not accept/);
  assert.equal(h.handoff.attached, false);
});
