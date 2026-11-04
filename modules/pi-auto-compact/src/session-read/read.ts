import { asRecord, str } from '../fold/util.ts';
import { MAX_ID_PARSE_BYTES, MAX_LINE_BYTES, scanLines } from './lines.ts';
import { renderEntry } from './render.ts';
import { integer, isCurrent, pickSession, SessionReadError, type SessionFile } from './sessions.ts';

export { SessionReadError };

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_CHARS_LIMIT = 50_000;
export const MAX_LINE_SPAN = 20;
const MIN_ROOM = 200;

export interface SessionReadRequest {
  sessionId?: string;
  line: number;
  toLine?: number;
  /** Entry id (or its first characters) the caller expects on `line`; a mismatch is reported instead of read. */
  id?: string;
  /** Character offset inside the first line's rendering, for continuing a truncated entry. */
  offset?: number;
  maxChars?: number;
}

export interface SessionReadResult {
  text: string;
  details: { sessionId: string; line: number; toLine: number; chars: number; truncated: boolean; nextLine?: number; nextOffset?: number;
    /** Set when the entry was not in the addressed session and was read from another readable one (`sessionId`). */
    redirectedFrom?: string };
}

const topLevelId = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  try { return str(asRecord(JSON.parse(text))?.id); } catch { return undefined; }
};

/** Locates the line of an entry id by scanning; used for the mismatch message only. */
async function findEntry(file: string, idPrefix: string): Promise<number | undefined> {
  for await (const item of scanLines(file, 2)) {
    if (item.text === undefined || item.bytes > MAX_ID_PARSE_BYTES || !item.text.includes(`"id":"${idPrefix}`)) continue;
    if (topLevelId(item.text)?.startsWith(idPrefix)) return item.line;
  }
  return undefined;
}

/** The first other readable session (current first, then ancestors outward) that holds the entry id. */
async function findInOtherSessions(readable: readonly SessionFile[], searched: SessionFile, idPrefix: string): Promise<{ session: SessionFile; line: number } | undefined> {
  for (const session of readable) {
    if (session === searched) continue;
    const line = await findEntry(session.file, idPrefix);
    if (line) return { session, line };
  }
  return undefined;
}

async function countLines(file: string): Promise<number> {
  let last = 0;
  for await (const item of scanLines(file)) last = item.line;
  return last;
}

/**
 * Reads one or several session lines as readable text. The caller supplies the readable sessions, so the scope rule (the
 * current session and its ancestors only) lives in one place and this function cannot be pointed at another file.
 */
export async function readSessionLines(readable: readonly SessionFile[], request: SessionReadRequest): Promise<SessionReadResult> {
  const target = pickSession(readable, request.sessionId);
  const line = integer(request.line, 'line', 1);
  const toLine = request.toLine === undefined ? line : integer(request.toLine, 'to_line', line);
  if (toLine - line + 1 > MAX_LINE_SPAN) throw new SessionReadError(`At most ${MAX_LINE_SPAN} lines per call; read the next range with another call.`);
  const offset = request.offset === undefined ? 0 : integer(request.offset, 'offset', 0);
  const maxChars = Math.min(MAX_CHARS_LIMIT, request.maxChars === undefined ? DEFAULT_MAX_CHARS : integer(request.maxChars, 'max_chars', 1000));
  const expectedId = request.id?.trim() || undefined;

  const notFoundText = () => ` No entry with that id was found in ${readable.length > 1 ? `any readable session (${readable.map(item => item.id).join(', ')})` : 'this session'}.`;
  /** A Fork's file holds only the parent's active branch, so a reference minted in the parent can name an entry that is not here.
   *  The ancestors are readable anyway: search them once (nearest first) and read the entry from the first session that has it. */
  const readFromOtherSession = async (why: string): Promise<SessionReadResult | undefined> => {
    const elsewhere = expectedId ? await findInOtherSessions(readable, target, expectedId) : undefined;
    if (!elsewhere) return undefined;
    const found = await readSessionLines(readable, { sessionId: elsewhere.session.id, line: elsewhere.line, id: expectedId, offset: request.offset, maxChars: request.maxChars });
    const note = `[Entry ${JSON.stringify(expectedId!.slice(0, 40))} is not in session ${target.id} (${why}); read from session ${elsewhere.session.id}, line ${elsewhere.line}.]`;
    return { text: `${note}\n${found.text}`, details: { ...found.details, redirectedFrom: target.id } };
  };

  const out: string[] = [];
  let used = 0, lastLine = line - 1, truncated = false, nextLine: number | undefined, nextOffset: number | undefined;
  for await (const item of scanLines(target.file, line, toLine)) {
    if (item.line === line && expectedId) {
      const actual = topLevelId(item.text);
      if (!actual?.startsWith(expectedId)) {
        const holds = actual ? JSON.stringify(actual) : 'a line without an entry id';
        const moved = await findEntry(target.file, expectedId);
        const redirected = moved ? undefined : await readFromOtherSession(`line ${line} holds ${holds}`);
        if (redirected) return redirected;
        throw new SessionReadError(`Line ${line} does not hold entry ${JSON.stringify(expectedId.slice(0, 40))} (it holds ${holds}).${moved ? ` That entry is at line ${moved}.` : notFoundText()}`);
      }
    }
    if (item.text === undefined) {
      out.push(`L${item.line}: [line is ${Math.round(item.bytes / 1024 / 1024)}MB, over the ${MAX_LINE_BYTES / 1024 / 1024}MB limit; not read]`);
      lastLine = item.line;
      continue;
    }
    const { head, body } = renderEntry(item.line, item.text);
    const start = item.line === line ? Math.min(offset, body.length) : 0;
    const room = maxChars - used - head.length - 2;
    if (room < MIN_ROOM && out.length > 0) { truncated = true; nextLine = item.line; break; }
    const shown = body.slice(start, start + Math.max(room, MIN_ROOM));
    const end = start + shown.length;
    out.push(`${head}\n${shown}${end < body.length ? `\n[truncated: chars ${start}-${end} of ${body.length}]` : ''}`);
    used += head.length + shown.length + 2;
    lastLine = item.line;
    if (end < body.length) { truncated = true; nextLine = item.line; nextOffset = end; break; }
  }
  if (out.length === 0) {
    // A line number minted in a longer ancestor file can lie past the end of this one.
    const moved = expectedId ? await findEntry(target.file, expectedId) : undefined;
    const redirected = moved ? undefined : await readFromOtherSession(`line ${line} is past its end`);
    if (redirected) return redirected;
    throw new SessionReadError(`Line ${line} is past the end of the session file (${await countLines(target.file)} lines).${expectedId ? (moved ? ` Entry ${JSON.stringify(expectedId.slice(0, 40))} is at line ${moved}.` : notFoundText()) : ''}`);
  }
  let text = out.join('\n---\n');
  if (nextLine !== undefined) {
    const args = [`line=${nextLine}`, nextOffset ? `offset=${nextOffset}` : '', toLine > nextLine ? `to_line=${toLine}` : '', isCurrent(readable, target) ? '' : `session_id=${target.id}`].filter(Boolean).join(' ');
    text += `\n[more: call session_read again with ${args}]`;
  }
  return { text, details: { sessionId: target.id, line, toLine: lastLine, chars: text.length, truncated, ...(nextLine !== undefined ? { nextLine } : {}), ...(nextOffset ? { nextOffset } : {}) } };
}
