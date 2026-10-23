/** Plain JSON-style object (not null, not an array): the shape guard for untrusted payloads. */
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
