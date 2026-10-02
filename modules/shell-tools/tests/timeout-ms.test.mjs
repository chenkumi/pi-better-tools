import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TIMEOUT_MS,
  timeoutMsToRenderSeconds,
  timeoutMsToSeconds,
} from "../src/timeout-ms.mjs";

test("omitted timeout and the maximum sentinel both mean no timeout", () => {
  assert.equal(timeoutMsToSeconds(undefined), undefined);
  assert.equal(timeoutMsToSeconds(MAX_TIMEOUT_MS), undefined);
});

test("milliseconds convert to seconds for Pi's shell executor", () => {
  assert.equal(timeoutMsToSeconds(20_000), 20);
  assert.equal(timeoutMsToSeconds(1), 0.001);
});

test("renderer receives seconds so the built-in TUI displays the correct duration", () => {
  assert.equal(timeoutMsToRenderSeconds(20_000), 20);
  assert.equal(timeoutMsToRenderSeconds(120_000), 120);
  assert.equal(timeoutMsToRenderSeconds(MAX_TIMEOUT_MS), undefined);
});

test("renderer adapter tolerates incomplete streaming arguments", () => {
  assert.equal(timeoutMsToRenderSeconds(undefined), undefined);
  assert.equal(timeoutMsToRenderSeconds("20000"), undefined);
  assert.equal(timeoutMsToRenderSeconds(Infinity), undefined);
});

test("rejects invalid timeout values", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => timeoutMsToSeconds(value), /positive integer/);
  }
});

test("rejects values above Node/Pi's maximum timer duration", () => {
  assert.throws(() => timeoutMsToSeconds(MAX_TIMEOUT_MS + 1), /must not exceed/);
});
