import { sanitizeText } from './output.ts';
import { supportsNativeSearch, type ModelIdentity } from './native-openai.ts';

export const SOURCE_ENTRY_TYPE = 'pi-web-tools.native-sources';
export const MAX_SOURCE_ENTRIES = 50;
export const MAX_SOURCE_BYTES = 24 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export interface Source { url: string; title?: string }
export interface Citation extends Source { startIndex?: number; endIndex?: number }
export interface NativeSourceRecord {
  version: 1; responseId: string; provider: string; api: string; model: string;
  status: 'completed' | 'incomplete'; sources: Source[]; citations: Citation[]; truncated: boolean;
}
export interface ParsedProviderEvent extends ModelIdentity { model: string; data: unknown }

function identifier(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}
function source(value: unknown): Source | undefined {
  if (!record(value) || typeof value.url !== 'string' || value.url.length > 2048 || /[\u0000-\u0020\u007f-\u009f]/.test(value.url)) return;
  let url: URL;
  try { url = new URL(value.url); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return;
  const title = typeof value.title === 'string' ? sanitizeText(value.title.slice(0, 600)).replace(/[\r\n\t]/g, ' ').slice(0, 300) : undefined;
  return { url: url.href, ...(title ? { title } : {}) };
}
function citation(value: unknown): Citation | undefined {
  const clean = source(value);
  if (!clean || !record(value)) return;
  const start = value.start_index ?? value.startIndex, end = value.end_index ?? value.endIndex;
  return { ...clean, ...(Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (end as number) >= (start as number)
    ? { startIndex: start as number, endIndex: end as number } : {}) };
}

/** Only terminal response output is inspected. Never copy raw events or query/auth fields. */
export function captureNativeSources(event: ParsedProviderEvent): NativeSourceRecord | undefined {
  if (!supportsNativeSearch(event) || !identifier(event.model, 256) || !record(event.data)) return;
  if (!['response.completed', 'response.incomplete'].includes(event.data.type as string)) return;
  const response = event.data.response;
  if (!record(response) || !identifier(response.id, 256) || !['completed', 'incomplete'].includes(response.status as string) || event.data.type !== `response.${response.status}`) return;
  const result: NativeSourceRecord = { version: 1, responseId: response.id, provider: event.provider, api: event.api, model: event.model,
    status: response.status as NativeSourceRecord['status'], sources: [], citations: [], truncated: false };
  const seen = new Set<string>();
  const add = (kind: 'sources' | 'citations', value: Source | Citation | undefined) => {
    if (!value) return;
    const key = kind === 'sources' ? `sources:${value.url}` : `citations:${JSON.stringify([value.url, (value as Citation).startIndex, (value as Citation).endIndex])}`;
    if (seen.has(key)) return;
    if (result.sources.length + result.citations.length >= MAX_SOURCE_ENTRIES) { result.truncated = true; return; }
    const list = result[kind];
    list.push(value);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_SOURCE_BYTES) { list.pop(); result.truncated = true; return; }
    seen.add(key);
  };
  const bounded = (value: unknown, limit = 100): unknown[] => {
    if (!Array.isArray(value)) return [];
    if (value.length > limit) result.truncated = true;
    return value.slice(0, limit);
  };
  for (const item of bounded(response.output)) {
    if (!record(item)) continue;
    if (item.type === 'web_search_call' && record(item.action)) {
      for (const s of bounded(item.action.sources)) add('sources', source(s));
    } else if (item.type === 'message') {
      for (const content of bounded(item.content, 20)) {
        if (!record(content) || content.type !== 'output_text') continue;
        for (const annotation of bounded(content.annotations)) {
          if (record(annotation) && annotation.type === 'url_citation') add('citations', citation(annotation));
        }
      }
    }
  }
  return result.sources.length || result.citations.length ? result : undefined;
}

/** Re-validate allowlisted data when reading persisted entries, which can be user-edited. */
export function readSourceRecord(value: unknown): NativeSourceRecord | undefined {
  if (!record(value) || value.version !== 1 || !identifier(value.responseId, 256) || !identifier(value.provider, 128) ||
      !identifier(value.api, 128) || !identifier(value.model, 256) || !['completed', 'incomplete'].includes(value.status as string) ||
      !Array.isArray(value.sources) || !Array.isArray(value.citations) || value.sources.length + value.citations.length > MAX_SOURCE_ENTRIES) return;
  const result: NativeSourceRecord = { version: 1, responseId: value.responseId, provider: value.provider, api: value.api, model: value.model,
    status: value.status as NativeSourceRecord['status'], sources: value.sources.map(source).filter((s): s is Source => !!s),
    citations: value.citations.map(citation).filter((s): s is Citation => !!s), truncated: value.truncated === true };
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_SOURCE_BYTES ? result : undefined;
}

export function formatSourceRecord(value: NativeSourceRecord): string {
  return [`Latest captured sources on this branch (not necessarily the last answer): ${value.responseId}`,
    `Provider: ${value.provider} | Model: ${value.model} | Response: ${value.status}`,
    ...(value.truncated ? ['Warning: captured sources were truncated.'] : []),
    'External, untrusted search sources:', ...value.sources.map(s => `${s.title ?? 'Source'}\n${s.url}`),
    'External, untrusted answer citations:', ...value.citations.map(s => `${s.title ?? 'Citation'}${s.startIndex !== undefined ? ` [${s.startIndex}, ${s.endIndex}]` : ''}\n${s.url}`),
  ].join('\n');
}
