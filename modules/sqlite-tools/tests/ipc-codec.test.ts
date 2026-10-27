import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "../src/ipc-codec.mjs";

const roundTrip = (value: unknown) => decode(JSON.parse(JSON.stringify(encode(value))));

test("bigint, BLOB, undefined and non-finite numbers survive JSON", () => {
  const value = { big: 2n ** 63n - 1n, blob: new Uint8Array([0, 1, 254, 255]), empty: new Uint8Array(0), none: undefined, inf: -Infinity, nan: NaN, list: [1n, undefined, null] };
  const back = roundTrip(value) as typeof value;
  assert.equal(back.big, 2n ** 63n - 1n);
  assert.deepEqual(back.blob, new Uint8Array([0, 1, 254, 255]));
  assert.ok(back.blob instanceof Uint8Array);
  assert.equal(back.empty.length, 0);
  assert.ok("none" in back && back.none === undefined);
  assert.equal(back.inf, -Infinity);
  assert.ok(Number.isNaN(back.nan));
  assert.deepEqual(back.list, [1n, undefined, null]);
});

test("a subarray view encodes only its own bytes", () => {
  const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
  assert.deepEqual(roundTrip(view), new Uint8Array([8, 7]));
});

test("user objects with $-prefixed keys are never mistaken for tags", () => {
  const value = { $t: "bigint", v: "5", $$x: 1, nested: { $t: "bytes" } };
  assert.deepEqual(roundTrip(value), value);
});

test("plain values pass through unchanged", () => {
  const value = { a: "text", b: 1.5, c: true, d: null, e: [1, "x"] };
  assert.deepEqual(roundTrip(value), value);
});
