import { defineTool, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { sessionToolRenderers } from './display.ts';
import { grepSession } from './grep.ts';
import { readSessionLines } from './read.ts';
import { resolveReadableSessions, SessionReadError } from './sessions.ts';
import { readWindow } from './window.ts';

export const SESSION_READ_TOOL = 'session_read';
export const SESSION_WINDOW_TOOL = 'session_window';
export const SESSION_GREP_TOOL = 'session_grep';

/** The three tools are a funnel: outline a range or search by keyword, then read the details of one entry. */
export const sessionNamespace = {
  name: 'session',
  description: 'To look back at earlier parts of this conversation (outline a range of lines, search by keyword, read one entry), use tool_search to find and load the session tools.',
};

const shared = {
  exposure: 'deferred' as const,
  namespace: sessionNamespace,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const sessionIdParam = Type.Optional(Type.String({ description: 'Session named by the summary; defaults to the current session. Only this session and the sessions it was forked from can be read.' }));
const strict = { additionalProperties: false };

/** Resolves the readable sessions from the host context, runs `action`, and reports the module's own errors under one code. */
async function withSessions<T>(ctx: ExtensionContext, action: (readable: Awaited<ReturnType<typeof resolveReadableSessions>>, leafId: string | undefined) => Promise<T>): Promise<T> {
  const manager = ctx.sessionManager;
  const readable = await resolveReadableSessions({ id: manager.getSessionId(), file: manager.getSessionFile() });
  try { return await action(readable, manager.getLeafId() ?? undefined); }
  catch (error) {
    if (error instanceof SessionReadError) throw new Error(`SESSION_FAILED: ${error.message}`);
    throw error;
  }
}

const range = (from: unknown, to: unknown) => (typeof from === 'number' ? `L${from}${typeof to === 'number' && to > from ? `–${to}` : ''}` : '');

/**
 * Reads lines of the current session file or of one of its ancestors (the sessions this one was forked from), never an
 * arbitrary file.
 */
export const sessionReadTool = defineTool({
  ...shared,
  name: SESSION_READ_TOOL,
  label: 'Session Read',
  description:
    'Read an earlier entry of this conversation by the line reference shown in a compaction summary, outline or search result, e.g. ⟦L1234:a1b2c3d4⟧ → line=1234, id="a1b2c3d4". ' +
    'Returns the entry as readable text: images, thinking and base64 blobs are replaced by placeholders and long entries are paged with offset. ' +
    'Always pass id: if that entry is not in the addressed session (a Fork file lacks some entries of its parent), it is looked up in the ancestor sessions and read from there, with a note saying which session.',
  promptSnippet: 'Read an earlier conversation entry by the line reference (⟦L<line>:<id>⟧) from a compaction summary.',
  promptGuidelines: ['When a compaction summary cites ⟦L<line>:<id>⟧ and you need the original tool output, call session_read with that line and id instead of repeating the work.'],
  parameters: Type.Object({
    line: Type.Integer({ minimum: 1, description: 'Line number from the reference, e.g. 1234 for ⟦L1234:a1b2c3d4⟧.' }),
    id: Type.Optional(Type.String({ description: 'Entry id from the reference (a1b2c3d4). Strongly recommended: a line that no longer holds this entry is reported instead of read.' })),
    to_line: Type.Optional(Type.Integer({ minimum: 1, description: 'Last line when reading a range (at most 20 lines per call).' })),
    session_id: sessionIdParam,
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset inside the first line, to continue a truncated entry.' })),
    max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: 'Output budget in characters (default 20000).' })),
  }, strict),
  ...sessionToolRenderers({
    title: 'Session Read',
    call: args => `${range(args.line, args.to_line)}${typeof args.session_id === 'string' ? ` session ${args.session_id.slice(0, 8)}` : ''}`.trim(),
    result: details => `Read L${String(details.line ?? '?')}${typeof details.toLine === 'number' && details.toLine !== details.line ? `–${details.toLine}` : ''}: ${String(details.chars ?? '?')} chars${details.truncated === true ? ' (truncated, more available)' : ''}`,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    const result = await withSessions(ctx, readable => readSessionLines(readable, { sessionId: params.session_id, line: params.line, toLine: params.to_line, id: params.id, offset: params.offset, maxChars: params.max_chars }));
    return { content: [{ type: 'text', text: result.text }], details: result.details };
  },
});

/** Outline of a line range with the L3 rules: conversation text only, no tool calls. */
export const sessionWindowTool = defineTool({
  ...shared,
  name: SESSION_WINDOW_TOOL,
  label: 'Session Window',
  description:
    'Outline a range of this conversation by line number: user and assistant text clipped (a progress checkpoint is listed by its title), compaction boundaries marked, each with a ⟦L<line>:<id>⟧ reference for session_read. Tool calls and results are not listed: find them with session_grep, or read an entry with session_read. ' +
    'After a compaction the visible history may start late; use before=<first line you can see> to look further back. Entries on abandoned branches are marked.',
  promptSnippet: 'Outline a range of earlier conversation lines (use before=<line> to look further back).',
  parameters: Type.Object({
    from: Type.Optional(Type.Integer({ minimum: 1, description: 'First line of the range.' })),
    to: Type.Optional(Type.Integer({ minimum: 1, description: 'Last line of the range (default from+59, at most 400 lines).' })),
    before: Type.Optional(Type.Integer({ minimum: 2, description: 'Read backwards: the lines before this line. Use instead of from/to.' })),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 400, description: 'With before: how many lines (default 60).' })),
    session_id: sessionIdParam,
    max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000, description: 'Output budget in characters (default 8000).' })),
  }, strict),
  ...sessionToolRenderers({
    title: 'Session Window',
    call: args => (typeof args.before === 'number' ? `before L${args.before}` : range(args.from, args.to)),
    result: details => `Outlined L${String(details.from ?? '?')}–${String(details.to ?? '?')}: ${String(details.entries ?? '?')} entries${details.truncated === true ? ' (truncated, more available)' : ''}`,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    const result = await withSessions(ctx, (readable, leafId) => readWindow(readable, { sessionId: params.session_id, from: params.from, to: params.to, before: params.before, count: params.count, maxChars: params.max_chars, leafId }));
    return { content: [{ type: 'text', text: result.text }], details: result.details };
  },
});

/** Keyword search of the decoded conversation; one line per matching entry. */
export const sessionGrepTool = defineTool({
  ...shared,
  name: SESSION_GREP_TOOL,
  label: 'Session Grep',
  description:
    'Search this conversation for a keyword, like grep for the transcript: user and assistant text, tool calls and tool results. Literal, case-insensitive text only (no regular expressions). ' +
    'Each hit is one line with a short snippet and a ⟦L<line>:<id>⟧ reference for session_read. Thinking and images are not searched; entries on abandoned branches are hidden unless include_other_branches is set.',
  promptSnippet: 'Search the conversation transcript for a keyword; hits carry ⟦L<line>:<id>⟧ references for session_read.',
  parameters: Type.Object({
    pattern: Type.String({ minLength: 2, maxLength: 200, description: 'Literal text to find (case-insensitive).' }),
    role: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('tool')], { description: 'Only user text, assistant text, or tool calls and results.' })),
    tool: Type.Optional(Type.String({ description: 'Only calls and results of this tool, e.g. "bash".' })),
    from: Type.Optional(Type.Integer({ minimum: 1, description: 'First line to search (default: start of the session).' })),
    to: Type.Optional(Type.Integer({ minimum: 1, description: 'Last line to search.' })),
    include_other_branches: Type.Optional(Type.Boolean({ description: 'Also search abandoned branches (default false).' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Maximum matching entries (default 30).' })),
    session_id: sessionIdParam,
  }, strict),
  ...sessionToolRenderers({
    title: 'Session Grep',
    call: args => `${typeof args.pattern === 'string' ? JSON.stringify(args.pattern.slice(0, 60)) : ''}${typeof args.tool === 'string' ? ` tool ${args.tool.slice(0, 30)}` : ''}`.trim(),
    result: details => `${String(details.hits ?? '?')} matching entries${details.truncated === true ? ' (more available)' : ''}${typeof details.hiddenOtherBranch === 'number' && details.hiddenOtherBranch > 0 ? `, ${details.hiddenOtherBranch} on other branches hidden` : ''}`,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    const result = await withSessions(ctx, (readable, leafId) => grepSession(readable, { sessionId: params.session_id, pattern: params.pattern, role: params.role, tool: params.tool, from: params.from, to: params.to, includeOtherBranches: params.include_other_branches, limit: params.limit, leafId, signal }));
    return { content: [{ type: 'text', text: result.text }], details: result.details };
  },
});

export const sessionTools = [sessionGrepTool, sessionWindowTool, sessionReadTool];
