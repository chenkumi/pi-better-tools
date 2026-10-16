const MAX_ROWS = 200;
const MAX_BYTES = 48 * 1024;
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
    return typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
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

export function formatRows(rows: Array<Record<string, unknown>>, totalRows: number | null): FormattedRows {
  const safeRows: Array<Record<string, unknown>> = [];
  let truncated = rows.length > MAX_ROWS;

  for (const row of rows.slice(0, MAX_ROWS)) {
    const candidate = [...safeRows, sanitiseRow(row)];
    const candidateText = JSON.stringify({ rows: candidate }, null, 2);
    if (Buffer.byteLength(candidateText, "utf8") > MAX_BYTES) {
      truncated = true;
      break;
    }
    safeRows.push(candidate[candidate.length - 1]!);
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
