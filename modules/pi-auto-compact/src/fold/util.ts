/** Folded text goes back into the model context, so every helper bounds length and strips control characters. */

export const MAX_LINE = 600;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Collapses whitespace and removes control characters so a folded entry is always one line. */
export function oneLine(value: string, max = MAX_LINE): string {
  return clip(value.replace(/\s+/g, ' ').replace(CONTROL, '').trim(), max);
}

/**
 * Best-effort masking of credentials that commonly appear in commands and arguments. It is not a guarantee: a secret in an
 * unrecognised shape survives, which is why the fold never keeps more of a command than its first characters.
 */
export function redact(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***')
    .replace(/\b((?:pass(?:word|wd)?|secret|token|api[-_]?key|auth(?:orization)?|credential)s?)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s&;|]+)/gi, '$1$2***')
    .replace(/(--(?:pass(?:word)?|token|secret|api-?key)[= ])\S+/gi, '$1***')
    .replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1***@');
}

const SECRET_KEY = /pass(word|wd)?|secret|token|api[-_]?key|credential|authorization|cookie/i;

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** First line of text parsed as JSON, then the whole text. Returns undefined when neither parses. */
export function parseJson(text: string): unknown {
  for (const candidate of [text.split('\n', 1)[0] ?? '', text]) {
    const trimmed = candidate.trim();
    if (!trimmed || !'{["'.includes(trimmed[0]!)) continue;
    try { return JSON.parse(trimmed); } catch { /* try the next candidate */ }
  }
  return undefined;
}

export const shortHash = (value: unknown): string | undefined => { const text = str(value); return text ? text.slice(0, 8) : undefined; };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

/** Non-empty lines, each flattened and clipped. */
export function textLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

export function tailLines(text: string, count: number, width = 160): string[] {
  return textLines(text).slice(-count).map(line => oneLine(line, width));
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Drops query and fragment: URLs routinely carry tokens in them. */
export function safeUrl(value: unknown, max = 200): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return oneLine(`${url.protocol}//${url.host}${url.pathname}${url.search || url.hash ? '?…' : ''}`, max);
  } catch { return oneLine(text.split(/[?#]/, 1)[0] ?? '', max); }
}

/** A short, credential-masked summary of arbitrary arguments, for tools without a dedicated rule. */
export function summarizeArgs(args: unknown, max = 80): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(asRecord(args) ?? {})) {
    if (value === undefined) continue;
    const shown = SECRET_KEY.test(key) ? '***' : typeof value === 'string' ? JSON.stringify(redact(value)) : JSON.stringify(value);
    parts.push(`${key}=${shown ?? 'null'}`);
  }
  return oneLine(redact(parts.join(' ')), max);
}
