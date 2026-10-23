const MAX_ROWS = 200;
const MAX_BYTES = 48 * 1024;
/** Longer string cell values are cut and marked with an ellipsis. */
const MAX_STRING_CHARS = 4_000;
const SENSITIVE_COLUMN = /^(password|password_hash|secret|token|access_token|refresh_token|api_key)$/i;

export interface FormattedRows {
  text: string;
  details: {
    returnedRows: number;
    totalRows: number | null;
    truncated: boolean;
  };
}

function normaliseValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return typeof value === "string" && value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer: ${value.length} bytes]`;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function sanitiseRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, SENSITIVE_COLUMN.test(key) ? "[REDACTED]" : normaliseValue(value)]),
  );
}

/** UTF-8 size of `row` as an element of `{ rows: [...] }` pretty-printed with 2-space indentation. */
function nestedRowBytes(row: Record<string, unknown>): number {
  const text = JSON.stringify(row, null, 2);
  // Nesting at depth 2 prefixes every line of the element with four spaces.
  return Buffer.byteLength(text, "utf8") + 4 * (text.split("\n").length);
}

export function formatRows(rows: Array<Record<string, unknown>>, totalRows: number | null): FormattedRows {
  const safeRows: Array<Record<string, unknown>> = [];
  let truncated = rows.length > MAX_ROWS;
  // Size of JSON.stringify({ rows: safeRows }, null, 2), kept incrementally instead of re-serializing every prefix.
  const emptyBytes = Buffer.byteLength(JSON.stringify({ rows: [] }, null, 2), "utf8");
  const frameBytes = Buffer.byteLength('{\n  "rows": [\n\n  ]\n}', "utf8");
  let rowBytes = 0;

  for (const row of rows.slice(0, MAX_ROWS)) {
    const candidate = sanitiseRow(row);
    const nextRowBytes = rowBytes + nestedRowBytes(candidate) + (safeRows.length ? 2 : 0); // ",\n" separator
    if (Math.max(emptyBytes, frameBytes + nextRowBytes) > MAX_BYTES) {
      truncated = true;
      break;
    }
    rowBytes = nextRowBytes;
    safeRows.push(candidate);
  }

  const payload = {
    rows: safeRows,
    returnedRows: safeRows.length,
    totalRows,
    truncated,
  };
  return {
    text: JSON.stringify(payload, null, 2),
    details: {
      returnedRows: safeRows.length,
      totalRows,
      truncated,
    },
  };
}
