import assert from "node:assert/strict";
import test from "node:test";
import { compileSchema } from "../src/schema.ts";

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "object", properties, ...extra });

test("validates types, required, bounds, enums and formats", () => {
  const schema = compileSchema(obj({ a: { type: "string", minLength: 2 }, n: { type: "integer", minimum: 0 }, k: { enum: ["x", "y"] }, e: { type: "string", format: "email" } }, { required: ["a"] }));
  assert.equal(schema.validate({ a: "ok", n: 1, k: "x", e: "a@b.co" }), undefined);
  assert.match(schema.validate({ n: 1 })!, /a/);
  assert.ok(schema.validate({ a: "x" }));
  assert.ok(schema.validate({ a: "ok", n: 1.5 }));
  assert.ok(schema.validate({ a: "ok", k: "z" }));
  assert.ok(schema.validate({ a: "ok", e: "nope" }));
});

test("additionalProperties, arrays, anyOf and local $ref are enforced", () => {
  const strict = compileSchema(obj({ a: { type: "string" } }, { additionalProperties: false }));
  assert.equal(strict.validate({ a: "x" }), undefined);
  assert.ok(strict.validate({ a: "x", b: 1 }));
  const list = compileSchema(obj({ l: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true } }));
  assert.equal(list.validate({ l: ["a"] }), undefined);
  assert.ok(list.validate({ l: [] }));
  assert.ok(list.validate({ l: ["a", "a"] }));
  const union = compileSchema(obj({ v: { anyOf: [{ type: "string" }, { type: "number" }] } }));
  assert.equal(union.validate({ v: 1 }), undefined);
  assert.ok(union.validate({ v: true }));
  const ref = compileSchema(JSON.stringify({ type: "object", $defs: { s: { type: "string" } }, properties: { r: { $ref: "#/$defs/s" } } }));
  assert.equal(ref.validate({ r: "x" }), undefined);
  assert.ok(ref.validate({ r: 1 }));
});

test("validation does not rewrite data (defaults are not injected)", () => {
  const schema = compileSchema(obj({ d: { type: "string", default: "z" } }));
  const data: Record<string, unknown> = {};
  assert.equal(schema.validate(data), undefined);
  assert.deepEqual(data, {});
});

test("the tool schema drops $schema but keeps the caller's constraints", () => {
  const schema = compileSchema(JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } }));
  assert.equal("$schema" in schema.jsonSchema, false);
  assert.equal(schema.jsonSchema.type, "object");
});

test("rejects malformed schemas", () => {
  for (const text of ["", "{", "[]", '"x"', '{"type":"array"}', '{"properties":{}}', '{"type":"object","required":7}', '{"type":"object","properties":[]}', '{"type":"object","properties":{"a":{"type":"nope"}}}']) {
    assert.throws(() => compileSchema(text), Error, text);
  }
});

test("rejects constructs zod cannot validate instead of silently accepting data", () => {
  const unsupported: Record<string, Record<string, unknown>> = {
    "if/then": { if: { required: ["a"] }, then: { required: ["b"] } },
    not: { not: { required: ["a"] } },
    dependentRequired: { dependentRequired: { a: ["b"] } },
    unevaluatedProperties: { unevaluatedProperties: false },
    "external $ref": { properties: { r: { $ref: "https://example.com/x.json" } } },
    "$anchor ref": { $defs: { a: { $anchor: "x", type: "string" } }, properties: { r: { $ref: "#x" } } },
  };
  for (const [name, extra] of Object.entries(unsupported)) {
    assert.throws(() => compileSchema(JSON.stringify({ type: "object", properties: {}, ...extra })), /unsupported|only local|\$ref/, name);
  }
});

test("rejects type-specific constraints without a type (they would be ignored)", () => {
  assert.throws(() => compileSchema(obj({ v: { allOf: [{ type: "string" }, { minLength: 3 }] } })), /minLength.*explicit "type"/);
  assert.throws(() => compileSchema(obj({ v: { minimum: 5 } })), /minimum/);
  assert.throws(() => compileSchema(obj({ v: { items: { type: "string" } } })), /items/);
  // The same constraints are fine once the type is declared.
  assert.doesNotThrow(() => compileSchema(obj({ v: { allOf: [{ type: "string" }, { type: "string", minLength: 3 }] } })));
});

test("tuple-form items are audited element by element", () => {
  assert.throws(() => compileSchema(obj({ t: { type: "array", items: [{ type: "string" }, { not: { type: "string" } }] } })), /not/);
  assert.throws(() => compileSchema(obj({ t: { type: "array", items: [{ minLength: 1 }] } })), /minLength/);
});
