import type { FoldRule, ToolCallInfo, ToolResultInfo } from '../types.ts';
import { asRecord, list, num, oneLine, parseJson, plural, redact, safeUrl, str } from '../util.ts';

const detailsOf = (result: ToolResultInfo) => asRecord(result.details) ?? {};
const sql = (call: ToolCallInfo) => JSON.stringify(oneLine(redact(str(call.args.sql) ?? ''), 200));

/** Column names live only in the first row of the JSON text; row values are never kept. */
function columnsOf(text: string): string {
  const parsed = asRecord(parseJson(text));
  const columns = Array.isArray(parsed?.columns) ? parsed.columns.map(String) : Object.keys(asRecord(list(parsed?.rows)[0]) ?? {});
  return columns.length ? ` [${oneLine(columns.slice(0, 8).join(','), 100)}${columns.length > 8 ? ',…' : ''}]` : '';
}

function rowsOutcome(result: ToolResultInfo): string {
  const d = detailsOf(result);
  const parsed = asRecord(parseJson(result.text));
  const returned = num(d.returnedRows) ?? num(parsed?.rowCount) ?? list(parsed?.rows).length;
  const total = num(d.totalRows);
  const truncated = d.truncated === true || parsed?.truncated === true;
  return `${plural(returned, 'row')}${total !== undefined && total !== returned ? ` of ${total}` : ''}${truncated ? ' (truncated)' : ''}${columnsOf(result.text)}`;
}

function sqlRules(engine: string): Record<string, FoldRule> {
  return {
    [`${engine}_state`]: { args: () => '', ok: (_call, result) => { const d = detailsOf(result); return d.connected === false ? 'not connected' : 'connected'; } },
    [`${engine}_query`]: { args: sql, ok: (_call, result) => rowsOutcome(result) },
    [`${engine}_update`]: {
      args: call => [sql(call), str(call.args.reason) ? `reason ${JSON.stringify(oneLine(redact(String(call.args.reason)), 100))}` : ''].filter(Boolean).join(' '),
      ok: (_call, result) => { const affected = num(detailsOf(result).affectedRows); return affected !== undefined ? plural(affected, 'row') + ' affected' : oneLine(result.text, 120); },
    },
  };
}

const sqliteJson = (result: ToolResultInfo) => asRecord(parseJson(result.text)) ?? {};

export const dataRules: Record<string, FoldRule> = {
  ...sqlRules('mysql'), ...sqlRules('mssql'), ...sqlRules('pgsql'),
  sqlite_open: { args: call => oneLine(str(call.args.file_path) ?? '', 160), ok: (_call, result) => oneLine(str(sqliteJson(result).message) ?? 'opened', 160) },
  sqlite_close: { args: () => '', ok: () => 'closed' },
  sqlite_status: {
    args: () => '',
    ok: (_call, result) => {
      const s = sqliteJson(result);
      return s.isOpen === true ? `open ${oneLine(str(s.filePath) ?? '', 160)}${num(s.tables) !== undefined ? `, ${plural(num(s.tables)!, 'table')}` : ''}` : 'no database open';
    },
  },
  sqlite_query: { args: sql, ok: (_call, result) => rowsOutcome(result) },
  sqlite_execute: {
    args: sql,
    ok: (_call, result) => { const s = sqliteJson(result); return num(s.changes) !== undefined ? `${plural(num(s.changes)!, 'change')}` : oneLine(result.text, 120); },
  },
  sqlite_list_tables: { args: () => '', ok: (_call, result) => plural(list(sqliteJson(result).tables).length, 'table') },
  sqlite_describe_table: {
    args: call => str(call.args.table_name) ?? '',
    ok: (_call, result) => { const s = sqliteJson(result); return `${plural(list(s.columns).length, 'column')}${num(s.rowCount) !== undefined ? `, ${plural(num(s.rowCount)!, 'row')}` : ''}`; },
  },
  /** The manual is reference text; none of it is kept. */
  sqlite_manual: { args: () => '', ok: () => 'manual read (content not kept)' },
  web_fetch: {
    args: call => safeUrl(call.args.url) ?? '',
    ok: (call, result) => {
      const d = detailsOf(result);
      const status = num(d.status), title = str(d.title), final = safeUrl(d.finalUrl);
      const moved = final && final !== safeUrl(call.args.url) ? ` → ${final}` : '';
      return `${status ?? 'ok'}${title ? ` ${JSON.stringify(oneLine(title, 100))}` : ''}${moved}${d.truncated === true ? ' (truncated)' : ''}; page content not kept`;
    },
    errorMax: 200,
  },
  web_search: {
    args: call => JSON.stringify(oneLine(redact(str(call.args.query) ?? ''), 120)),
    ok: (_call, result) => {
      const d = detailsOf(result);
      const urls = [...new Set([...result.text.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(match => safeUrl(match[0], 100)!))].slice(0, 3);
      return `${plural(num(d.count) ?? urls.length, 'result')}${str(d.provider) ? ` via ${d.provider}` : ''}${urls.length ? `: ${urls.join(' ')}` : ''}; snippets not kept`;
    },
    errorMax: 200,
  },
  remote_list: {
    args: () => '',
    ok: (_call, result) => {
      const peers = list(detailsOf(result).peers).map(asRecord).map(peer => str(peer?.name)).filter((name): name is string => name !== undefined && /^[a-z0-9-]+$/.test(name));
      return `${plural(peers.length, 'peer')}${peers.length ? `: ${peers.slice(0, 8).join(', ')}` : ''}`;
    },
  },
  remote_send: {
    args: call => [str(call.args.name), str(call.args.kind)].filter((item): item is string => item !== undefined && /^[\w*-]{1,64}$/.test(item)).join(' '),
    ok: (_call, result) => { const d = detailsOf(result); return `${str(d.status) ?? 'sent'} (delivered is not acted on)`; },
    errorMax: 200,
  },
  remote_status: {
    args: call => str(call.args.id) ?? '',
    ok: (_call, result) => { const d = detailsOf(result); return `${str(d.state) ?? str(d.status) ?? 'status'}${Array.isArray(d.sends) ? `, ${plural(d.sends.length, 'send')}` : ''}`; },
    errorMax: 200,
  },
  tool_search: {
    args: call => JSON.stringify(oneLine(str(call.args.query) ?? '', 100)),
    ok: (_call, result) => { const loaded = list(detailsOf(result).loaded).map(String); return loaded.length ? `loaded ${loaded.slice(0, 12).join(', ')}${loaded.length > 12 ? ', …' : ''}` : 'no matching tools'; },
  },
  /** The structured result is the point of the call, so it is kept whole (bounded). */
  json_output: { args: () => '', ok: (_call, result) => oneLine(result.text, 4000) },
};
