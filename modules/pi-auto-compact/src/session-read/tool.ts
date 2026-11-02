import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { sessionToolRenderers } from './display.ts';
import { readSessionLines, SessionReadError } from './read.ts';
import { resolveReadableSessions } from './sessions.ts';

export const SESSION_READ_TOOL = 'session_read';

/**
 * Read-only. Reads lines of the current session file or of one of its ancestors (the sessions this one was forked from),
 * never an arbitrary file. Not active by default: it is meant to be selected together with the compaction that cites it.
 */
export const sessionReadTool = defineTool({
  name: SESSION_READ_TOOL,
  label: 'Session Read',
  description:
    'Read an earlier entry of this conversation by the line reference shown in a compaction summary, e.g. ⟦L1234:a1b2c3d4⟧ → line=1234, id="a1b2c3d4". ' +
    'Returns the entry as readable text: images, thinking and base64 blobs are replaced by placeholders and long entries are paged with offset. ' +
    'Only the current session and the sessions it was forked from can be read; pass session_id when the summary names another one.',
  promptSnippet: 'Read an earlier conversation entry by the line reference (⟦L<line>:<id>⟧) from a compaction summary.',
  promptGuidelines: ['When a compaction summary cites ⟦L<line>:<id>⟧ and you need the original tool output, call session_read with that line and id instead of repeating the work.'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  defaultActive: false,
  parameters: Type.Object({
    line: Type.Integer({ minimum: 1, description: 'Line number from the reference, e.g. 1234 for ⟦L1234:a1b2c3d4⟧.' }),
    id: Type.Optional(Type.String({ description: 'Entry id from the reference (a1b2c3d4). Strongly recommended: a line that no longer holds this entry is reported instead of read.' })),
    to_line: Type.Optional(Type.Integer({ minimum: 1, description: 'Last line when reading a range (at most 20 lines per call).' })),
    session_id: Type.Optional(Type.String({ description: 'Session named by the summary; defaults to the current session.' })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset inside the first line, to continue a truncated entry.' })),
    max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: 'Output budget in characters (default 20000).' })),
  }, { additionalProperties: false }),
  ...sessionToolRenderers({
    title: 'Session Read',
    call: args => `${typeof args.line === 'number' ? `L${args.line}${typeof args.to_line === 'number' && args.to_line > args.line ? `–${args.to_line}` : ''}` : ''}${typeof args.session_id === 'string' ? ` session ${args.session_id.slice(0, 8)}` : ''}`.trim(),
    result: details => `Read L${String(details.line ?? '?')}${typeof details.toLine === 'number' && details.toLine !== details.line ? `–${details.toLine}` : ''}: ${String(details.chars ?? '?')} chars${details.truncated === true ? ' (truncated, more available)' : ''}`,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    const manager = ctx.sessionManager;
    const readable = await resolveReadableSessions({ id: manager.getSessionId(), file: manager.getSessionFile() });
    try {
      const result = await readSessionLines(readable, { sessionId: params.session_id, line: params.line, toLine: params.to_line, id: params.id, offset: params.offset, maxChars: params.max_chars });
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    } catch (error) {
      if (error instanceof SessionReadError) throw new Error(`SESSION_READ_FAILED: ${error.message}`);
      throw error;
    }
  },
});
