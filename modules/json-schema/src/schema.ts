import { createRequire } from "node:module";
import { validationPool } from "./validation-pool.ts";
export { VALIDATION_BUDGET_MS } from "./validation-pool.ts";
import { assertSafeSchemaPattern } from "./pattern-policy.ts";
import { childSchemas, formatIssues, SUBSCHEMA_LIST, toZodSchema } from "./validation-schema.mjs";

import type { ZodType } from "zod";

/** zod is heavy and only needed once structured output is requested; load it synchronously on first use, not at Pi startup. */
let zodModule: typeof import("zod") | undefined;
const loadZod = () => (zodModule ??= createRequire(import.meta.url)("zod") as typeof import("zod"));

/**
 * JSON Schema -> zod 4 validator.
 *
 * zod only covers part of JSON Schema and silently ignores some constructs, so the schema is audited first.
 * Anything this module cannot validate faithfully is rejected up front instead of letting invalid data through.
 */

export interface CompiledSchema {
  /** The caller's schema, reused as the `json_output` tool parameters. */
  jsonSchema: Record<string, unknown>;
  /** Returns undefined when `data` is valid, otherwise a short human-readable reason. */
  validate(data: unknown, signal?: AbortSignal): string | undefined | Promise<string | undefined>;
}

const UNSUPPORTED_KEYWORDS = new Set([
  "if", "then", "else", "not",
  "dependentRequired", "dependentSchemas", "dependencies",
  "unevaluatedProperties", "unevaluatedItems",
  "$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$anchor",
]);

/** Keywords that constrain one JSON type and are ignored by zod when the subschema declares no type. */
const TYPE_SPECIFIC_KEYWORDS = new Set([
  "minLength", "maxLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains", "minContains", "maxContains",
  "properties", "required", "additionalProperties", "patternProperties", "propertyNames", "minProperties", "maxProperties",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function audit(node: unknown, path: string): void {
  if (!isRecord(node)) return;
  for (const keyword of Object.keys(node)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) throw new Error(`unsupported JSON Schema keyword "${keyword}" at ${path}`);
  }
  if ("pattern" in node) assertSafeSchemaPattern(node.pattern, `${path}/pattern`);
  if (isRecord(node.patternProperties)) for (const name of Object.keys(node.patternProperties)) assertSafeSchemaPattern(name, `${path}/patternProperties`);
  const reference = node.$ref;
  if (reference !== undefined) {
    if (typeof reference !== "string" || !reference.startsWith("#")) throw new Error(`only local $ref values ("#...") are supported at ${path}`);
    if (reference !== "#" && !/^#\/(?:\$defs|definitions)\/[^/]+$/.test(reference)) {
      throw new Error(`unsupported $ref pointer at ${path}; use "#" or a direct "$defs"/"definitions" reference (inline descendant schemas)`);
    }
    const sibling = Object.keys(node).find(key => TYPE_SPECIFIC_KEYWORDS.has(key) || SUBSCHEMA_LIST.has(key) || ["type", "enum", "const"].includes(key));
    if (sibling) throw new Error(`$ref at ${path} has unsupported sibling "${sibling}"; use explicit-type allOf instead (draft semantics are not rewritten)`);
  }
  if ("required" in node && !(Array.isArray(node.required) && node.required.every((name) => typeof name === "string"))) throw new Error(`"required" at ${path} must be an array of strings`);
  if ("properties" in node && !isRecord(node.properties)) throw new Error(`"properties" at ${path} must be an object`);
  if ("enum" in node && !Array.isArray(node.enum)) throw new Error(`"enum" at ${path} must be an array`);
  if ("type" in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.every((name) => typeof name === "string" && ["object", "array", "string", "number", "integer", "boolean", "null"].includes(name))) throw new Error(`"type" at ${path} must be a JSON Schema type name or an array of them`);
  }
  if ("enum" in node || "const" in node) {
    // Zod's enum/const branch returns early: sibling validation is not intersected.
    const sibling = Object.keys(node).find(key => TYPE_SPECIFIC_KEYWORDS.has(key) || SUBSCHEMA_LIST.has(key) || key === "$ref" || (key === "const" && "enum" in node));
    if (sibling) throw new Error(`"${sibling}" at ${path} cannot be combined with enum/const (sibling constraints would be ignored)`);
    if ("type" in node) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      const values = "enum" in node ? node.enum as unknown[] : [node.const];
      const matches = (value: unknown, type: unknown) => type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? isRecord(value) : type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === type;
      if (!values.every(value => types.some(type => matches(value, type)))) throw new Error(`"type" at ${path} cannot conflict with enum/const values`);
    }
  }
  if (Array.isArray(node.required) && node.additionalProperties === false) {
    const declared = isRecord(node.properties) ? node.properties : {};
    const missing = node.required.find(name => !Object.hasOwn(declared, name));
    if (missing !== undefined) throw new Error(`"required" name "${String(missing)}" at ${path} is not declared in properties while additionalProperties is false`);
  }
  const constrains = Object.keys(node).find((keyword) => TYPE_SPECIFIC_KEYWORDS.has(keyword));
  const anchored = "type" in node || "$ref" in node || "enum" in node || "const" in node;
  if (constrains && !anchored) throw new Error(`"${constrains}" at ${path} needs an explicit "type" (it would be ignored otherwise)`);

  for (const [child, suffix] of childSchemas(node)) audit(child, `${path}/${suffix}`);
}

/** Detect patterns only in schema positions (not annotation/default/enum data). */
function usesPattern(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if ("pattern" in node || "patternProperties" in node) return true;
  for (const [child] of childSchemas(node)) if (usesPattern(child)) return true;
  return false;
}

/** The expansion budget reaches `$defs`/`definitions` only through `$ref`, as Zod's converter does. */
const EXPANDED_MAPS: ReadonlySet<string> = new Set(["properties", "patternProperties"]);

/** Bound acyclic reference/branch expansion before Zod compilation AND host tool registration.
 * Cyclic edges are counted once per active path: this is a schema structural budget,
 * not a bound on recursive data size or validation time for arbitrary instances.
 */
export const MAX_EXPANDED_SCHEMA_NODES = 2048;
function admitExpandedSchema(root: Record<string, unknown>): void {
  let visits = 0;
  const active = new Set<Record<string, unknown>>();
  const visit = (node: unknown, depth: number): void => {
    if (++visits > MAX_EXPANDED_SCHEMA_NODES || depth > 128) throw new Error(`schema expanded-work budget exceeded (max ${MAX_EXPANDED_SCHEMA_NODES} nodes, depth 128); flatten references or reduce branches`);
    if (!isRecord(node) || active.has(node)) return;
    active.add(node);
    if (typeof node.$ref === "string" && /^#(?:\/.*)?$/.test(node.$ref)) {
      const parts = node.$ref.slice(1).split("/").filter(Boolean).map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      // Zod's converter resolves definition names, not arbitrary descendant pointers.
      // Match ctx.defs precedence even when the reference prefix names the other map.
      // Unsupported descendant pointers are rejected by audit before compilation.
      const definitions = root.$defs || root.definitions || {};
      const target = parts.length === 0 ? root : isRecord(definitions) && Object.hasOwn(definitions, parts[1]) ? definitions[parts[1]] : undefined;
      visit(target, depth + 1);
    }
    for (const [child] of childSchemas(node, EXPANDED_MAPS)) visit(child, depth + 1);
    active.delete(node);
  };
  visit(root, 0);
}

/** Parse and compile a JSON Schema document whose root is `type: "object"`. Throws Error with a user-facing message. */
export function compileSchema(text: string): CompiledSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("schema must be a JSON object");
  if (parsed.type !== "object") throw new Error('schema root must declare "type": "object"');
  admitExpandedSchema(parsed);
  audit(parsed, "#");

  let validator: ZodType;
  try {
    validator = loadZod().z.fromJSONSchema(toZodSchema(parsed) as never);
  } catch (error) {
    throw new Error(`schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Exercise the compiled validator once so structurally broken schemas fail now, not after a model request.
  try {
    validator.safeParse({});
  } catch (error) {
    throw new Error(`schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }

  const isolated = usesPattern(parsed);
  const { $schema: _ignored, ...jsonSchema } = parsed;
  return {
    jsonSchema,
    validate(data, signal) {
      if (isolated) return validationPool.validate(parsed, data, signal);
      if (signal?.aborted) return "Validation cancelled";
      const result = validator.safeParse(data);
      if (result.success) return undefined;
      return formatIssues(result.error.issues);
    },
  };
}
