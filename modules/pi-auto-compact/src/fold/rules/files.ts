import type { FoldRule, ToolResultInfo } from '../types.ts';
import { asRecord, formatBytes, num, oneLine, plural, redact, shortHash, str, textLines } from '../util.ts';

const pathArg = (call: { args: Record<string, unknown> }) => oneLine(str(call.args.path) ?? str(call.args.file_path) ?? '.', 200);
const detailsOf = (result: ToolResultInfo) => asRecord(result.details) ?? {};

/** File paths of FFF search output: grep groups matches under an unindented path line, find lists one path per line. */
function searchedFiles(text: string, max = 3): string[] {
  const seen: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw || raw.startsWith(' ') || raw.startsWith('[') || /^(No |More |\d+ more )/.test(raw)) continue;
    const path = oneLine(raw.split(/ [[(]/, 1)[0] ?? '', 120);
    if (path && !seen.includes(path)) seen.push(path);
    if (seen.length === max) break;
  }
  return seen;
}

function searchOutcome(result: ToolResultInfo): string {
  const d = detailsOf(result);
  const matched = num(d.totalMatched), files = num(d.totalFiles);
  const names = searchedFiles(result.text);
  if (matched === undefined) return oneLine(textLines(result.text)[0] ?? 'ok', 160);
  if (matched === 0) return 'no matches';
  const more = d.hasMore === true ? ', more pages' : '';
  return `${plural(matched, 'hit')} in ${plural(files ?? names.length, 'file')}${names.length ? ` (${names.join(', ')}${(files ?? 0) > names.length ? ', …' : ''})` : ''}${more}`;
}

const quoted = (value: unknown, max = 80) => (str(value) ? JSON.stringify(oneLine(redact(String(value)), max)) : '');

export const fileRules: Record<string, FoldRule> = {
  read: {
    args: pathArg,
    ok: (_call, result) => {
      const d = detailsOf(result);
      const start = num(d.lineStart), end = num(d.lineEnd), total = num(d.totalLines);
      const range = start !== undefined && end !== undefined ? `lines ${start}–${end}${total !== undefined ? ` of ${total}` : ''}` : 'read';
      const hash = shortHash(d.sha256);
      return `${range}${hash ? ` sha:${hash}` : ''}${d.truncation ? ' (truncated)' : ''}`;
    },
  },
  write: {
    args: pathArg,
    ok: (_call, result) => {
      const d = detailsOf(result);
      const hash = shortHash(d.sha256), bytes = num(d.bytes);
      return `${d.created === true ? 'created' : 'overwrote'}${bytes !== undefined ? ` ${formatBytes(bytes)}` : ''}${hash ? ` sha:${hash}` : ''}`;
    },
  },
  edit: {
    args: pathArg,
    ok: (_call, result) => {
      const d = detailsOf(result);
      const applied = num(d.appliedEdits);
      const before = shortHash(d.sha256Before), after = shortHash(d.sha256After);
      const delta = num(d.added) !== undefined || num(d.removed) !== undefined ? ` +${num(d.added) ?? 0}/−${num(d.removed) ?? 0}` : '';
      const first = num(d.firstChangedLine);
      return `${applied !== undefined ? plural(applied, 'edit') : 'edited'}${delta}${first !== undefined ? ` @L${first}` : ''}${before && after ? ` sha:${before}→${after}` : ''}`;
    },
  },
  ls: {
    args: pathArg,
    ok: (_call, result) => {
      const lines = textLines(result.text).filter(line => !line.startsWith('['));
      const count = lines.length === 1 && lines[0] === '(empty directory)' ? 0 : lines.length;
      return `${plural(count, 'entry').replace('entrys', 'entries')}${detailsOf(result).entryLimitReached !== undefined ? ' (limit reached)' : ''}`;
    },
  },
  grep: { args: call => [quoted(call.args.pattern), str(call.args.path) ? `in ${pathArg(call)}` : ''].filter(Boolean).join(' '), ok: (_call, result) => searchOutcome(result) },
  find: { args: call => [quoted(call.args.pattern), str(call.args.path) ? `in ${pathArg(call)}` : ''].filter(Boolean).join(' '), ok: (_call, result) => searchOutcome(result) },
  multi_grep: {
    args: call => oneLine(redact(Array.isArray(call.args.patterns) ? call.args.patterns.map(item => JSON.stringify(String(item))).join(' ') : ''), 120),
    ok: (_call, result) => searchOutcome(result),
  },
  /** The reread content is the point of the call, but it is never folded back in: only where it came from and how much came back. */
  session_read: {
    args: call => {
      const line = num(call.args.line), to = num(call.args.to_line), session = str(call.args.session_id);
      return `${line !== undefined ? `L${line}${to !== undefined && to > line ? `–${to}` : ''}` : ''}${session ? ` session ${oneLine(session, 40)}` : ''}`.trim();
    },
    ok: (_call, result) => {
      const d = detailsOf(result);
      return `${plural(num(d.chars) ?? result.text.length, 'char')}${d.truncated === true ? ' (truncated)' : ''}; content not kept`;
    },
  },
  note: {
    args: call => str(call.args.type) ?? '',
    ok: (_call, result) => oneLine(str(detailsOf(result).relativePath) ?? 'saved', 200),
  },
};
