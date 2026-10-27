// JSON-safe encoding for the parent <-> SQLite process channel. The channel uses JSON serialization because
// Node's "advanced" (V8) format is not understood by other hosts such as Bun. JSON cannot carry bigint, BLOBs,
// undefined or non-finite numbers, so those travel as `{ "$t": ... }` tags; user keys starting with "$" get one
// extra "$" so a user object can never be mistaken for a tag. Plain JavaScript: the child runs on plain Node.
const TAG = "$t";

export function encode(value) {
  if (value === undefined) return { [TAG]: "undefined" };
  if (typeof value === "bigint") return { [TAG]: "bigint", v: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { [TAG]: "number", v: String(value) };
  if (value instanceof Uint8Array) return { [TAG]: "bytes", v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key.startsWith("$") ? `$${key}` : key] = encode(item);
    return out;
  }
  return value;
}

export function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if (TAG in value) {
    switch (value[TAG]) {
      case "undefined": return undefined;
      case "bigint": return BigInt(value.v);
      case "number": return Number(value.v);
      case "bytes": return new Uint8Array(Buffer.from(value.v, "base64"));
      default: throw new Error(`Unknown SQLite IPC tag: ${String(value[TAG])}`);
    }
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key.startsWith("$$") ? key.slice(1) : key] = decode(item);
  return out;
}
