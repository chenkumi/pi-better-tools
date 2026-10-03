import { z } from "zod";

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
  validate(data: unknown): string | undefined;
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

/** Keywords whose values are a single subschema, a subschema list, or a name -> subschema map. */
const SUBSCHEMA = new Set(["items", "additionalProperties", "contains", "propertyNames"]);
const SUBSCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SUBSCHEMA_MAP = new Set(["properties", "patternProperties", "$defs", "definitions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function audit(node: unknown, path: string): void {
  if (!isRecord(node)) return;
  for (const keyword of Object.keys(node)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) throw new Error(`unsupported JSON Schema keyword "${keyword}" at ${path}`);
  }
  const reference = node.$ref;
  if (reference !== undefined) {
    if (typeof reference !== "string" || !reference.startsWith("#")) throw new Error(`only local $ref values ("#...") are supported at ${path}`);
    if (!/^#(?:\/.*)?$/.test(reference)) throw new Error(`only JSON-pointer $ref values are supported at ${path}`);
  }
  if ("required" in node && !(Array.isArray(node.required) && node.required.every((name) => typeof name === "string"))) throw new Error(`"required" at ${path} must be an array of strings`);
  if ("properties" in node && !isRecord(node.properties)) throw new Error(`"properties" at ${path} must be an object`);
  if ("enum" in node && !Array.isArray(node.enum)) throw new Error(`"enum" at ${path} must be an array`);
  if ("type" in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.every((name) => typeof name === "string" && ["object", "array", "string", "number", "integer", "boolean", "null"].includes(name))) throw new Error(`"type" at ${path} must be a JSON Schema type name or an array of them`);
  }
  const constrains = Object.keys(node).find((keyword) => TYPE_SPECIFIC_KEYWORDS.has(keyword));
  const anchored = "type" in node || "$ref" in node || "enum" in node || "const" in node;
  if (constrains && !anchored) throw new Error(`"${constrains}" at ${path} needs an explicit "type" (it would be ignored otherwise)`);

  for (const [keyword, value] of Object.entries(node)) {
    // draft-07 tuple form: `items` may be an array of subschemas.
    if (SUBSCHEMA.has(keyword)) {
      if (Array.isArray(value)) value.forEach((child, index) => audit(child, `${path}/${keyword}/${index}`));
      else audit(value, `${path}/${keyword}`);
    }
    else if (SUBSCHEMA_LIST.has(keyword) && Array.isArray(value)) value.forEach((child, index) => audit(child, `${path}/${keyword}/${index}`));
    else if (SUBSCHEMA_MAP.has(keyword) && isRecord(value)) for (const [name, child] of Object.entries(value)) audit(child, `${path}/${keyword}/${name}`);
  }
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
  audit(parsed, "#");

  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(parsed as never);
  } catch (error) {
    throw new Error(`schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Exercise the compiled validator once so structurally broken schemas fail now, not after a model request.
  try {
    validator.safeParse({});
  } catch (error) {
    throw new Error(`schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { $schema: _ignored, ...jsonSchema } = parsed;
  return {
    jsonSchema,
    validate(data) {
      const result = validator.safeParse(data);
      if (result.success) return undefined;
      return result.error.issues.slice(0, 5).map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ");
    },
  };
}
