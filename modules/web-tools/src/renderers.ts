import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { sanitizeText } from './output.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown, max = 1000) => typeof value === 'string' || typeof value === 'number'
  ? sanitizeText(stripVTControlCharacters(String(value).slice(0, max * 4))).replace(/\r\n?/g, '\n').replace(/[\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : '';
const oneLine = (value: unknown, max = 300) => clean(value, max).replace(/\s+/g, ' ');
const urlLabel = (value: unknown) => {
  const text = oneLine(value, 8192);
  try { const url = new URL(text); url.username = ''; url.password = ''; return url.toString(); }
  catch { return text.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1'); }
};

/** Interactive hosts forward content/details, not structuredContent. Parse only a bounded,
 * best-effort preview of the existing formatted search text; never treat it as trusted metadata. */
function searchPreview(text: string) {
  const bounded = text.slice(0, 24 * 1024);
  return {
    query: /^Query: ([^\n]*)/m.exec(bounded)?.[1],
    results: Array.from(bounded.matchAll(/^\[\d+\] ([^\n]*)\n(https?:\/\/[^\n]+)/gm)).slice(0, 10).map(match => ({ title: match[1], url: match[2] })),
    warnings: Array.from(bounded.matchAll(/^Warning: ([^\n]*)/gm)).slice(0, 10).map(match => match[1]),
  };
}

export function webRenderers(kind: 'fetch' | 'search'): Pick<ToolDefinition, 'renderCall' | 'renderResult'> {
  const name = `web_${kind}`;
  return {
    renderCall(args, theme) {
      const input = record(args);
      const target = kind === 'fetch' ? urlLabel(input.url) : oneLine(input.query, 200);
      return new Text(`${theme.fg('toolTitle', theme.bold(name))} ${theme.fg('accent', target || '…')}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (context.isError) return new Text(theme.fg('error', `${name} failed\n${clean(text, expanded ? 4000 : 700)}`), 0, 0);
      if (isPartial) return new Text(theme.fg('muted', oneLine(text, 300) || `${name} loading…`), 0, 0);
      const details = record(result.details), structured = record(result.structuredContent);
      const structuredData = record(structured.data);
      const data: Record<string, unknown> = kind === 'search' && !Object.keys(structuredData).length ? searchPreview(text) : structuredData;
      const lines: string[] = [];
      if (kind === 'fetch') {
        lines.push(oneLine(details.title ?? data.title) || 'Fetched page',
          `URL: ${urlLabel(details.finalUrl ?? data.finalUrl ?? details.url ?? data.url) || 'unavailable'}`,
          `HTTP: ${oneLine(details.status ?? data.status) || '?'} · Extraction: ${oneLine(details.extraction ?? data.extraction) || '?'}`);
        if (details.fetchedAt ?? data.fetchedAt) lines.push(`Retrieved: ${oneLine(details.fetchedAt ?? data.fetchedAt)}`);
      } else {
        const sources = Array.isArray(data.results) ? data.results : [];
        lines.push(`Search: ${oneLine(details.provider ?? data.provider) || 'unknown provider'} · Results: ${oneLine(details.count) || String(sources.length)}`);
        if (data.query) lines.push(`Query: ${oneLine(data.query, 200)}`);
        if (!expanded) for (const source of sources.slice(0, 3)) {
          const item = record(source);
          lines.push(`• ${oneLine(item.title) || '(untitled)'}`, `  ${urlLabel(item.url)}`);
        }
        if (!expanded && sources.length > 3) lines.push(`… (${sources.length - 3} more sources; expand to view)`);
      }
      const warnings = details.warnings ?? data.warnings;
      if (Array.isArray(warnings)) for (const warning of warnings.slice(0, 10)) lines.push(`Warning: ${clean(warning, 500)}`);
      lines.push('External, untrusted content');
      if (expanded) lines.push(clean(text, 24000) + (text.length > 24000 ? '\n… (display preview truncated)' : ''));
      if (details.truncated === true || structured.truncated === true) lines.push('Output truncated');
      const fullPath = details.fullOutputPath ?? structured.fullOutputPath;
      if (fullPath) lines.push(`Full output: ${clean(fullPath, 2000)} (temporary file)`);
      return new Text(theme.fg('toolOutput', lines.join('\n')), 0, 0);
    },
  };
}
