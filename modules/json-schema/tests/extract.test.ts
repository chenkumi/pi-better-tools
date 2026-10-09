import assert from "node:assert/strict";
import test from "node:test";
import { extractJson, extractJsonCandidates } from "../src/extract.ts";

test("extracts the whole text, a fenced block, or the first balanced value", () => {
  assert.deepEqual(extractJson('{"a":1}'), { value: { a: 1 } });
  assert.deepEqual(extractJson('  {"a":1}\n'), { value: { a: 1 } });
  assert.deepEqual(extractJson('Result:\n```json\n{"a":2}\n```\nDone'), { value: { a: 2 } });
  assert.deepEqual(extractJson("```\n[1,2]\n```"), { value: [1, 2] });
  assert.deepEqual(extractJson('Here you go: {"a":3} thanks'), { value: { a: 3 } });
  assert.deepEqual(extractJson('prefix [1,{"b":[2]}] suffix'), { value: [1, { b: [2] }] });
});

test("braces and escapes inside strings do not end a value early", () => {
  assert.deepEqual(extractJson(String.raw`x {"a":"}{\"","b":1} y`), { value: { a: '}{"', b: 1 } });
});

test("skips unparsable candidates and reports when nothing is JSON", () => {
  assert.deepEqual(extractJson('{not json} then {"ok":true}'), { value: { ok: true } });
  assert.equal(extractJson("no json here"), undefined);
  assert.equal(extractJson('{"a":'), undefined);
  assert.equal(extractJson(""), undefined);
});

test("valid scalar documents are parsed as-is", () => {
  assert.deepEqual(extractJson("null"), { value: null });
  assert.deepEqual(extractJson("7"), { value: 7 });
});

test("huge unbalanced text is bounded and still finds nothing quickly", () => {
  assert.equal(extractJson("{".repeat(200_000)), undefined);
  assert.equal(extractJson("[1,".repeat(100_000)), undefined);
});

test("extractJsonCandidates returns every parsable candidate in order", () => {
  assert.deepEqual(extractJsonCandidates('first {} then [1] then {"a":1}').map((c) => c.value), [{}, [1], { a: 1 }]);
  assert.deepEqual(extractJsonCandidates("nothing"), []);
});
