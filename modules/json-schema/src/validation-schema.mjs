// Schema positions: keywords whose values are a single subschema, a subschema list, or a name -> subschema map.
// enum/const/default/unknown annotations contain instance data and are never walked.
export const SUBSCHEMA = new Set(['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames']);
export const SUBSCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
export const SUBSCHEMA_MAP = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Each direct child subschema with its path suffix, in key order. `maps` narrows which name -> subschema maps count. */
export function* childSchemas(node, maps = SUBSCHEMA_MAP) {
  for (const [key, value] of Object.entries(node)) {
    // draft-07 tuple form: `items` may be an array of subschemas.
    if (SUBSCHEMA.has(key)) {
      if (Array.isArray(value)) yield* value.map((child, index) => [child, `${key}/${index}`]);
      else yield [value, key];
    }
    else if (SUBSCHEMA_LIST.has(key) && Array.isArray(value)) yield* value.map((child, index) => [child, `${key}/${index}`]);
    else if (maps.has(key) && isRecord(value)) yield* Object.entries(value).map(([name, child]) => [child, `${key}/${name}`]);
  }
}

/** A copy of `node` with every direct child subschema replaced by `transform(child)`. */
function mapSubschemas(node, transform) {
  return Object.fromEntries(Object.entries(node).map(([key, value]) => {
    if (SUBSCHEMA.has(key)) return [key, Array.isArray(value) ? value.map(transform) : transform(value)];
    if (SUBSCHEMA_LIST.has(key) && Array.isArray(value)) return [key, value.map(transform)];
    if (SUBSCHEMA_MAP.has(key) && isRecord(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transform(child)]))];
    return [key, value];
  }));
}

// JSON Schema default is an annotation, not permission to accept missing required data.
export function withoutSchemaDefaults(node) {
  if (!isRecord(node)) return node;
  const { default: _default, ...rest } = node;
  return mapSubschemas(rest, withoutSchemaDefaults);
}

const declaresType = (node, name) => Array.isArray(node.type) ? node.type.includes(name) : node.type === name;
const isCompound = value => typeof value === 'object' && value !== null;
// zod compares const/enum members by identity, so object/array members never match. Express them structurally.
function structural(value) {
  if (Array.isArray(value)) return { type: 'array', prefixItems: value.map(structural), items: false, minItems: value.length, maxItems: value.length };
  if (isCompound(value)) {
    const keys = Object.keys(value);
    return { type: 'object', properties: Object.fromEntries(keys.map(key => [key, structural(value[key])])), required: keys, additionalProperties: false };
  }
  return { const: value };
}
// zod 4 also ignores minItems/maxItems on arrays without `items` and `required` names without a `properties` entry.
// The provider schema is never rewritten; only the validator copy is.
function withZodGaps(node) {
  let result = node;
  if ('const' in result && isCompound(result.const)) {
    const { const: value, type: _type, ...rest } = result;
    result = { ...rest, ...structural(value) };
  } else if (Array.isArray(result.enum) && result.enum.some(isCompound)) {
    const { enum: values, type: _type, ...rest } = result;
    result = { ...rest, anyOf: values.map(structural) };
  }
  if (declaresType(result, 'array') && result.items === undefined && result.prefixItems === undefined
    && (result.minItems !== undefined || result.maxItems !== undefined)) result = { ...result, items: {} };
  if (Array.isArray(result.required) && result.additionalProperties !== false) {
    const declared = isRecord(result.properties) ? result.properties : {};
    const missing = result.required.filter(name => typeof name === 'string' && !Object.hasOwn(declared, name));
    if (missing.length) result = { ...result, properties: { ...declared, ...Object.fromEntries(missing.map(name => [name, {}])) } };
  }
  return result;
}
/** Validator-only copy: defaults stripped (annotations), then zod gaps closed. Walks schema positions only. */
export function toZodSchema(root) {
  const walk = node => isRecord(node) ? mapSubschemas(withZodGaps(node), walk) : node;
  return walk(withoutSchemaDefaults(root));
}

/** The first five zod issues as one short human-readable reason. */
export function formatIssues(issues) {
  return issues.slice(0, 5).map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ');
}
