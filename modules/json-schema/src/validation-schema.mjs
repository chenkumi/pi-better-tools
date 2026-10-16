// JSON Schema default is an annotation, not permission to accept missing required data.
// Walk schema positions only: enum/const/default/unknown annotations contain instance data.
const single = new Set(['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames']);
const list = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const map = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
export function withoutSchemaDefaults(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'default').map(([key, value]) => {
    if (single.has(key)) return [key, Array.isArray(value) ? value.map(withoutSchemaDefaults) : withoutSchemaDefaults(value)];
    if (list.has(key) && Array.isArray(value)) return [key, value.map(withoutSchemaDefaults)];
    if (map.has(key) && value && typeof value === 'object' && !Array.isArray(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withoutSchemaDefaults(child)]))];
    return [key, value];
  }));
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
    const declared = result.properties && typeof result.properties === 'object' && !Array.isArray(result.properties) ? result.properties : {};
    const missing = result.required.filter(name => typeof name === 'string' && !Object.hasOwn(declared, name));
    if (missing.length) result = { ...result, properties: { ...declared, ...Object.fromEntries(missing.map(name => [name, {}])) } };
  }
  return result;
}
/** Validator-only copy: defaults stripped (annotations), then zod gaps closed. Walks schema positions only. */
export function toZodSchema(root) {
  const walk = rawNode => {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return rawNode;
    const node = withZodGaps(rawNode);
    return Object.fromEntries(Object.entries(node).map(([key, value]) => {
      if (single.has(key)) return [key, Array.isArray(value) ? value.map(walk) : walk(value)];
      if (list.has(key) && Array.isArray(value)) return [key, value.map(walk)];
      if (map.has(key) && value && typeof value === 'object' && !Array.isArray(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, walk(child)]))];
      return [key, value];
    }));
  };
  return walk(withoutSchemaDefaults(root));
}
