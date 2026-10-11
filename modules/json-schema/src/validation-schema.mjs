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
