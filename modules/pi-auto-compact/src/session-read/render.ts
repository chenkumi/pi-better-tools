import { asRecord, list, str } from '../fold/util.ts';

/** Strips control and bidirectional characters, keeping newline and tab, because the result goes back into the model context. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
export const clean = (value: string): string => value.replace(/\r\n?/g, '\n').replace(CONTROL, '');

const BASE64 = /^[A-Za-z0-9+/=\s]{1000,}$/;

/** JSON with long base64-looking strings replaced by a size placeholder, so an inline blob can never flood the result. */
export function compactJson(value: unknown, indent?: number): string {
  const text = JSON.stringify(value, (_key, item) => (typeof item === 'string' && BASE64.test(item) ? `[base64 ${item.length} chars omitted]` : item), indent);
  return text ?? 'undefined';
}

const kb = (chars: number) => `${(chars / 1024).toFixed(1)}KB`;

function renderBlock(block: unknown): string {
  const b = asRecord(block);
  if (!b) return typeof block === 'string' ? block : compactJson(block);
  switch (b.type) {
    case 'text': return str(b.text) ?? '';
    case 'image': return `[image: ${str(b.mimeType) ?? 'unknown type'}, ${kb(typeof b.data === 'string' ? b.data.length : 0)} base64 omitted]`;
    case 'thinking': return `[thinking: ${typeof b.thinking === 'string' ? b.thinking.length : 0} chars omitted]`;
    case 'toolCall': return `toolCall ${str(b.name) ?? '?'} (${str(b.id) ?? '?'})\n${compactJson(b.arguments, 2)}`;
    default: return compactJson(b);
  }
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content).map(renderBlock).join('\n');
}

export interface Rendered {
  /** One-line description of the entry (line, id, type, role, tool). */
  head: string;
  body: string;
}

/**
 * Turns one session line into readable text: JSON is decoded, images and thinking become placeholders, tool-call arguments and
 * details are printed as compact JSON. The result is a plain document that can be paged by character offset.
 */
export function renderEntry(line: number, raw: string): Rendered {
  let entry: Record<string, unknown> | undefined;
  try { entry = asRecord(JSON.parse(raw)); } catch { /* reported below */ }
  if (!entry) return { head: `L${line} (not valid JSON)`, body: clean(raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw) };
  const type = str(entry.type) ?? 'unknown';
  const id = str(entry.id);
  const message = asRecord(entry.message);
  const tags = [type, str(message?.role), str(message?.toolName), message?.isError === true ? 'error' : undefined].filter(Boolean).join(' ');
  const head = clean(`L${line}${id ? `:${id}` : ''} ${tags}${str(entry.timestamp) ? ` @ ${entry.timestamp}` : ''}`);
  const parts: string[] = [];
  if (message) {
    parts.push(renderContent(message.content));
    if (message.details !== undefined) parts.push(`details: ${compactJson(message.details, 2)}`);
  } else if (type === 'compaction' || type === 'branch_summary') {
    parts.push(str(entry.summary) ?? '');
  } else if (type === 'custom_message') {
    parts.push(renderContent(entry.content));
    if (entry.details !== undefined) parts.push(`details: ${compactJson(entry.details, 2)}`);
  } else {
    parts.push(compactJson(entry, 2));
  }
  return { head, body: clean(parts.filter(Boolean).join('\n')) };
}
