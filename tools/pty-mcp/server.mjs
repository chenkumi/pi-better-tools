// Local MCP server: run a program in a PTY and look at its *rendered screen* (not the raw ANSI stream), so a full-screen
// TUI such as Pi can be driven and observed. stdio transport; stdout carries only the protocol, logs go to stderr.
//
// Tools: term_spawn, term_screen, term_send, term_wait, term_resize, term_kill, term_list.
// node-pty (a native addon) is borrowed from the repository's node_modules (override with PTY_MCP_NODE_PTY).
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import xterm from '@xterm/headless';
import { z } from 'zod';

const { Terminal } = xterm;
const NODE_PTY = process.env.PTY_MCP_NODE_PTY ?? 'D:/GitHub/pi-better-tools-main/node_modules/node-pty';
const pty = createRequire(import.meta.url)(NODE_PTY);

const MAX_SESSIONS = 8, MAX_SCREEN_CHARS = 60_000, MAX_SCROLLBACK = 500, MAX_WAIT_MS = 120_000, DEFAULT_SETTLE_MS = 400, KEY_GAP_MS = 30;
const sessions = new Map();
let counter = 0;

const text = value => ({ content: [{ type: 'text', text: value }] });
const fail = message => ({ isError: true, content: [{ type: 'text', text: message }] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = id => sessions.get(id);

// ------------------------------------------------------------------------------------------------------------------ keys
const NAMED = {
  enter: '\r', return: '\r', tab: '\t', escape: '\x1b', esc: '\x1b', backspace: '\x7f', delete: '\x1b[3~', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  insert: '\x1b[2~', 'shift+tab': '\x1b[Z',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
function keyBytes(name) {
  const key = name.trim().toLowerCase();
  if (key in NAMED) return NAMED[key];
  const ctrl = /^ctrl\+([a-z\[\\\]^_@])$/.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1] === '@' ? 0 : ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
  const alt = /^alt\+(.+)$/.exec(key);
  if (alt) return `\x1b${alt[1] in NAMED ? NAMED[alt[1]] : alt[1]}`;
  if (name.length === 1) return name;
  throw new Error(`Unknown key "${name}". Use names like Enter, Tab, Escape, Up, Down, Left, Right, Home, End, PageUp, PageDown, Backspace, Delete, F1-F12, Shift+Tab, Ctrl+C, Alt+Enter, or a single character.`);
}

// ---------------------------------------------------------------------------------------------------------------- screen
function snapshot(session, scrollback = 0) {
  const buffer = session.term.buffer.active, rows = session.term.rows;
  const line = y => (buffer.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, '');
  const top = buffer.baseY, out = [];
  if (scrollback > 0) for (let y = Math.max(0, top - Math.min(scrollback, MAX_SCROLLBACK)); y < top; y++) out.push(line(y));
  const visible = [];
  for (let y = 0; y < rows; y++) visible.push(line(top + y));
  let last = visible.length - 1;
  while (last > 0 && visible[last] === '' && last > buffer.cursorY) last--;
  out.push(...visible.slice(0, last + 1));
  let body = out.join('\n');
  if (body.length > MAX_SCREEN_CHARS) body = `…[truncated ${body.length - MAX_SCREEN_CHARS} chars]\n${body.slice(body.length - MAX_SCREEN_CHARS)}`;
  const state = session.exit ? `exited code=${session.exit.exitCode}${session.exit.signal ? ` signal=${session.exit.signal}` : ''}` : 'running';
  const alt = buffer.type === 'alternate' ? ' alt-screen' : '';
  return `[${session.id} ${state} ${session.term.cols}x${rows}${alt} cursor row=${buffer.cursorY + 1} col=${buffer.cursorX + 1}${scrollback > 0 ? ` scrollback=${Math.min(scrollback, top)}` : ''}]\n${body}`;
}

/** Waits until the output has been quiet for `settleMs`, the session exited, or the timeout passed. */
async function settle(session, settleMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (session.exit) return 'exited';
    if (Date.now() - session.lastDataAt >= settleMs) return 'idle';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(40);
  }
}

// ----------------------------------------------------------------------------------------------------------------- server
const server = new McpServer({ name: 'pty-mcp', version: '0.1.0' });
const ms = (max, fallback) => z.number().int().min(0).max(max).optional().describe(`milliseconds, default ${fallback}, at most ${max}`);

server.registerTool('term_spawn', {
  description: 'Start a program in a new PTY and return its session id. On Windows a command that is not an .exe (for example "pi", an npm shim) is run through cmd.exe automatically. Use term_screen / term_send afterwards.',
  inputSchema: {
    command: z.string().min(1).describe('Program to run, e.g. "pi" or "powershell.exe" or "node".'),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional().describe('Working directory (default: the directory this server was started in).'),
    env: z.record(z.string(), z.string()).optional().describe('Extra environment variables.'),
    cols: z.number().int().min(20).max(400).optional().describe('default 120'),
    rows: z.number().int().min(5).max(200).optional().describe('default 40'),
    settleMs: ms(10_000, DEFAULT_SETTLE_MS),
  },
}, async ({ command, args = [], cwd, env, cols = 120, rows = 40, settleMs = DEFAULT_SETTLE_MS }) => {
  if (sessions.size >= MAX_SESSIONS) return fail(`At most ${MAX_SESSIONS} sessions; term_kill one first.`);
  let file = command, argv = args;
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(command)) {
    const quote = value => (/[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
    file = 'cmd.exe';
    argv = `/d /s /c "${[command, ...args].map(quote).join(' ')}"`;
  }
  let child;
  try { child = pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd: cwd ?? process.cwd(), env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env } }); }
  catch (error) { return fail(`Could not start "${command}": ${error instanceof Error ? error.message : String(error)}`); }
  const session = { id: `s${++counter}`, command: [command, ...args].join(' '), child, term: new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true }), exit: undefined, lastDataAt: Date.now(), startedAt: Date.now() };
  child.onData(data => { session.lastDataAt = Date.now(); session.term.write(data); });
  child.onExit(result => { session.exit = result; session.lastDataAt = Date.now(); });
  // Answer terminal queries (cursor position, device attributes) the way a real terminal would, so TUIs do not stall waiting.
  session.term.onData(reply => { if (!session.exit) try { child.write(reply); } catch { /* exited */ } });
  sessions.set(session.id, session);
  await settle(session, settleMs, 5000);
  return text(snapshot(session));
});

server.registerTool('term_screen', {
  description: 'Show the current rendered screen of a session (what a person would see), optionally with some scrollback above it.',
  inputSchema: { sessionId: z.string(), scrollback: z.number().int().min(0).max(MAX_SCROLLBACK).optional().describe('extra lines above the screen, default 0') },
}, async ({ sessionId, scrollback = 0 }) => {
  const session = get(sessionId);
  return session ? text(snapshot(session, scrollback)) : fail(`No session ${sessionId}. term_list shows the open ones.`);
});

server.registerTool('term_send', {
  description: 'Type into a session: literal `text` first, then `keys` in order, then wait until the screen is quiet and return it. Text is sent as typed (no newline is added; use keys ["Enter"]).',
  inputSchema: {
    sessionId: z.string(),
    text: z.string().optional().describe('Literal characters to type.'),
    keys: z.array(z.string()).optional().describe('Named keys: Enter, Tab, Escape, Up, Down, Left, Right, Home, End, PageUp, PageDown, Backspace, Delete, F1-F12, Shift+Tab, Ctrl+C, Alt+Enter, or a single character.'),
    settleMs: ms(10_000, DEFAULT_SETTLE_MS),
    timeoutMs: ms(MAX_WAIT_MS, 5000),
  },
}, async ({ sessionId, text: typed, keys = [], settleMs = DEFAULT_SETTLE_MS, timeoutMs = 5000 }) => {
  const session = get(sessionId);
  if (!session) return fail(`No session ${sessionId}. term_list shows the open ones.`);
  if (session.exit) return fail(`Session ${sessionId} has exited.\n${snapshot(session)}`);
  const chunks = [];
  if (typed) chunks.push(typed);
  try { for (const key of keys) chunks.push(keyBytes(key)); } catch (error) { return fail(error.message); }
  if (chunks.length === 0) return fail('Give text or keys.');
  session.lastDataAt = Date.now();
  // One write per key with a short gap, like a keyboard: a TUI tells a lone Escape from the start of an escape sequence by timing.
  for (const [index, chunk] of chunks.entries()) { if (index > 0) await sleep(KEY_GAP_MS); session.child.write(chunk); }
  const how = await settle(session, settleMs, timeoutMs);
  return text(`${snapshot(session)}${how === 'timeout' ? '\n[still changing when the timeout passed]' : ''}`);
});

server.registerTool('term_wait', {
  description: 'Wait until a regular expression matches the visible screen, or the screen has been quiet for idleMs, or the session exited, or the timeout passed; then return the screen.',
  inputSchema: {
    sessionId: z.string(),
    pattern: z.string().max(200).optional().describe('JavaScript RegExp source tested against the rendered screen text.'),
    idleMs: ms(60_000, 1000),
    timeoutMs: ms(MAX_WAIT_MS, 30_000),
  },
}, async ({ sessionId, pattern, idleMs = 1000, timeoutMs = 30_000 }) => {
  const session = get(sessionId);
  if (!session) return fail(`No session ${sessionId}. term_list shows the open ones.`);
  let re;
  try { re = pattern ? new RegExp(pattern, 'm') : undefined; } catch (error) { return fail(`Bad pattern: ${error.message}`); }
  const deadline = Date.now() + timeoutMs;
  let reason = 'timeout';
  for (;;) {
    if (re && re.test(snapshot(session))) { reason = 'matched'; break; }
    if (session.exit) { reason = 'exited'; break; }
    if (!re && Date.now() - session.lastDataAt >= idleMs) { reason = 'idle'; break; }
    if (Date.now() >= deadline) break;
    await sleep(80);
  }
  return text(`[wait: ${reason}]\n${snapshot(session)}`);
});

server.registerTool('term_resize', {
  description: 'Resize the terminal of a session.',
  inputSchema: { sessionId: z.string(), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) },
}, async ({ sessionId, cols, rows }) => {
  const session = get(sessionId);
  if (!session) return fail(`No session ${sessionId}.`);
  if (session.exit) return fail(`Session ${sessionId} has exited.`);
  session.child.resize(cols, rows); session.term.resize(cols, rows);
  await settle(session, DEFAULT_SETTLE_MS, 3000);
  return text(snapshot(session));
});

server.registerTool('term_kill', {
  description: 'Close a session and free it. Closing does not promise that the descendants of the program have stopped (Windows has no signals for a PTY).',
  inputSchema: { sessionId: z.string() },
}, async ({ sessionId }) => {
  const session = get(sessionId);
  if (!session) return fail(`No session ${sessionId}.`);
  const last = snapshot(session);
  dispose(session);
  return text(`Closed ${sessionId}. Last screen:\n${last}`);
});

server.registerTool('term_list', { description: 'List the open sessions.', inputSchema: {} }, async () => {
  if (sessions.size === 0) return text('No sessions.');
  return text([...sessions.values()].map(s => `${s.id}  ${s.exit ? `exited(${s.exit.exitCode})` : 'running'}  ${s.term.cols}x${s.term.rows}  ${Math.round((Date.now() - s.startedAt) / 1000)}s  ${s.command.slice(0, 100)}`).join('\n'));
});

function dispose(session) {
  sessions.delete(session.id);
  try { session.child.kill(); } catch { /* already gone */ }
  try { session.term.dispose(); } catch { /* ignore */ }
}
const shutdown = () => { for (const session of [...sessions.values()]) dispose(session); };
process.on('exit', shutdown);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown(); process.exit(0); });
process.stdin.on('end', () => { shutdown(); process.exit(0); });

await server.connect(new StdioServerTransport());
console.error('pty-mcp ready');
