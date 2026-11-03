// End-to-end check over the real MCP stdio protocol. Starts the server, drives small programs, checks the rendered screen.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: 'pty-mcp-test', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'pipe' }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError === true, text: r.content.map(c => c.text).join('\n') }; };

console.log('[test] tools:', (await client.listTools()).tools.map(t => t.name).join(', '));

// 1. Cursor-addressed drawing lands where a person would see it (needs a terminal emulator, not a raw stream).
let r = await call('term_spawn', { command: process.execPath, args: ['-e', "process.stdout.write('\\x1b[2J\\x1b[5;10HHELLO\\x1b[7;3Hworld');setTimeout(()=>{},60000)"], cols: 60, rows: 12 });
assert.ok(!r.error, r.text);
const id1 = /^\[(s\d+)/.exec(r.text)[1];
const lines = r.text.split('\n');
assert.ok(lines[5]?.startsWith('         HELLO'), `HELLO at row 5 col 10:\n${r.text}`);
assert.ok(lines[7]?.startsWith('  world'), `world at row 7 col 3:\n${r.text}`);
console.log('[test] screen rendering ok');

// 2. Keys reach the program as the right bytes.
r = await call('term_spawn', { command: process.execPath, args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',d=>console.log('GOT '+JSON.stringify(d.toString())))"] });
const id2 = /^\[(s\d+)/.exec(r.text)[1];
r = await call('term_send', { sessionId: id2, keys: ['Up', 'Escape', 'Ctrl+C', 'Shift+Tab', 'Alt+x'], settleMs: 600 });
for (const expected of ['GOT "\\u001b[A"', 'GOT "\\u001b"', 'GOT "\\u0003"', 'GOT "\\u001b[Z"', 'GOT "\\u001bx"']) assert.ok(r.text.includes(expected), `${expected}\n${r.text}`);
console.log('[test] keys ok');

// 3. An interactive shell: type, read the result, wait for a pattern, exit code.
r = await call('term_spawn', { command: 'cmd.exe', args: ['/d', '/q'] });
const id3 = /^\[(s\d+)/.exec(r.text)[1];
r = await call('term_send', { sessionId: id3, text: 'echo MCP_SMOKE_%RANDOM%', keys: ['Enter'] });
assert.match(r.text, /MCP_SMOKE_\d+/, r.text);
r = await call('term_wait', { sessionId: id3, pattern: 'MCP_SMOKE_\\d+', timeoutMs: 3000 });
assert.ok(r.text.startsWith('[wait: matched]'), r.text);
r = await call('term_send', { sessionId: id3, text: 'exit 7', keys: ['Enter'] });
r = await call('term_wait', { sessionId: id3, timeoutMs: 5000 });
assert.match(r.text, /exited code=7/, r.text);
console.log('[test] shell, wait and exit code ok');

// 4. A command that is not an .exe goes through cmd.exe (this is how "pi" is started on Windows).
r = await call('term_spawn', { command: 'node', args: ['-e', "console.log('VIA_SHIM_'+(1+1))"] });
assert.match(r.text, /VIA_SHIM_2/, r.text);
console.log('[test] shim launch ok');

// 5. Errors are reported, not thrown; list and kill work.
assert.ok((await call('term_screen', { sessionId: 'nope' })).error);
assert.ok((await call('term_send', { sessionId: id2, keys: ['NotAKey'] })).error);
assert.ok((await call('term_list')).text.includes(id1));
assert.ok(!(await call('term_kill', { sessionId: id1 })).error);
assert.ok(!(await call('term_list')).text.includes(`${id1} `));
await call('term_kill', { sessionId: id2 });
console.log('[test] errors, list and kill ok');

await client.close();
console.log('[test] all passed');
process.exit(0);
