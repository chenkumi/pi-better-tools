/** Encodes bigint, Uint8Array, undefined and non-finite numbers into JSON-safe tagged values. */
export function encode(value: unknown): unknown;
export function decode(value: unknown): unknown;
