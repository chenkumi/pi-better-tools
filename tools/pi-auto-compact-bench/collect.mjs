// Summarises a Pi session file after a run: compactions, per-compaction stats of pi-auto-compact, tool-call counts, usage.
//   node collect.mjs <session.jsonl>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node collect.mjs <session.jsonl>'); process.exit(2); }
const entries = readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const tools = {}, usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, assistantMessages: 0 };
const compactions = [];
entries.forEach((e, index) => {
  if (e.type === 'compaction') compactions.push({ line: index + 1, tokensBefore: e.tokensBefore, summaryChars: String(e.summary ?? '').length, compactor: e.details?.compactor ?? 'other', stats: e.details?.stats });
  const m = e.message;
  if (e.type !== 'message' || m?.role !== 'assistant') return;
  usage.assistantMessages++;
  usage.input += m.usage?.input ?? 0; usage.output += m.usage?.output ?? 0; usage.cacheRead += m.usage?.cacheRead ?? 0; usage.cacheWrite += m.usage?.cacheWrite ?? 0; usage.cost += m.usage?.cost?.total ?? 0;
  for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'toolCall') tools[b.name] = (tools[b.name] ?? 0) + 1;
});
const recall = ['session_read', 'session_grep', 'session_window'].reduce((n, t) => n + (tools[t] ?? 0), 0);
const cacheShare = usage.input + usage.cacheRead > 0 ? usage.cacheRead / (usage.input + usage.cacheRead) : 0;
console.log(`compactions: ${compactions.length}`);
compactions.forEach((c, i) => console.log(`  #${i + 1} entry ${c.line} by ${c.compactor}: tokensBefore=${c.tokensBefore} summaryChars=${c.summaryChars}${c.stats ? ` guard=${c.stats.guard} windowStartKept=${c.stats.windowStartKept} cutMoved=${c.stats.cutMoved} l2Lent=${c.stats.l2Lent} keptChars=${c.stats.keptChars} activityChars=${c.stats.activityChars} conversationChars=${c.stats.conversationChars}` : ''}`));
console.log(`recall tool calls (session_read/grep/window): ${recall}`);
console.log(`tool calls: ${JSON.stringify(tools)}`);
console.log(`usage: input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} cacheReadShare=${cacheShare.toFixed(3)} cost=${usage.cost.toFixed(4)} assistantMessages=${usage.assistantMessages}`);

// ---------------------------------------------------------------------------------------------------- after each compaction
// What the agent does in the turns after a compaction: does it still know the goal (continues with the next item instead of
// restarting or repeating), and does it re-load documents it had already read (re-reads, re-orientation)?
const targetOf = args => String(args?.path ?? args?.file_path ?? args?.command ?? args?.pattern ?? '').replaceAll(String.fromCharCode(92), '/');
const baseOf = target => target.split('/').pop() ?? target;
const itemOf = target => { const m = /(?:mod|result)-(\d{3})/.exec(target); return m ? Number(m[1]) : undefined; };
const ORIENT = /(^|\/)(TASKS|PROMPT)\.md$/i;
const resultChars = new Map();
for (const e of entries) if (e.message?.role === 'toolResult') resultChars.set(e.message.toolCallId, (Array.isArray(e.message.content) ? e.message.content : []).reduce((n, b) => n + (b.text?.length ?? 0), 0));
const steps = entries.map((e, index) => ({ e, index })).filter(({ e }) => e.type === 'compaction' || (e.type === 'message' && e.message?.role === 'assistant'));
const resultIndex = new Map(entries.map((e, index) => [e.message?.toolCallId, index]).filter(([id]) => id));
const readBefore = new Map(), wroteBefore = new Set();   // path -> id of its latest read call
let lastItem = 0;
const TURNS = 6;
console.log(`\nbehaviour after each compaction (first ${TURNS} assistant turns):`);
let compactionNo = 0;
for (let s = 0; s < steps.length; s++) {
  const step = steps[s];
  if (step.e.type !== 'compaction') {
    for (const b of Array.isArray(step.e.message.content) ? step.e.message.content : []) {
      if (b.type !== 'toolCall') continue;
      const t = targetOf(b.arguments);
      if (b.name === 'read') readBefore.set(t, b.id);
      if (b.name === 'write' || b.name === 'edit') { wroteBefore.add(t); lastItem = Math.max(lastItem, itemOf(t) ?? 0); }
    }
    continue;
  }
  compactionNo++;
  const turns = [];
  for (let k = s + 1; k < steps.length && steps[k].e.type !== 'compaction' && turns.length < TURNS; k++) turns.push(steps[k].e.message);
  const calls = turns.flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'toolCall'));
  const reads = calls.filter(c => c.name === 'read'), rereads = reads.filter(c => readBefore.has(targetOf(c.arguments)));
  const orientation = calls.filter(c => (c.name === 'read' && ORIENT.test(targetOf(c.arguments))) || ['ls', 'find', 'glob', 'ffind', 'fffind'].includes(c.name));
  const writes = calls.filter(c => c.name === 'write' || c.name === 'edit');
  const repeated = writes.filter(c => wroteBefore.has(targetOf(c.arguments)));
  const firstWrite = writes.map(c => itemOf(targetOf(c.arguments))).find(n => n !== undefined);
  // A re-read is a rebuild when the earlier result was folded away by this compaction; it is waste when that result was still in
  // the raw tail the compaction kept (the content was visible and read again anyway).
  const keptFrom = entries.findIndex(e => e.id === step.e.firstKeptEntryId);
  const wasted = rereads.filter(c => (resultIndex.get(readBefore.get(targetOf(c.arguments))) ?? -1) >= keptFrom);
  const wastedChars = wasted.reduce((n, c) => n + (resultChars.get(c.id) ?? 0), 0);
  const rereadChars = rereads.reduce((n, c) => n + (resultChars.get(c.id) ?? 0), 0), allReadChars = reads.reduce((n, c) => n + (resultChars.get(c.id) ?? 0), 0);
  const first = calls[0], firstText = turns.map(m => (Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'text').map(b => b.text).join(' ')).find(t => t.trim());
  const continuity = firstWrite === undefined ? 'no write yet' : firstWrite === lastItem + 1 ? 'continues with the next item' : firstWrite <= lastItem ? `REPEATS item ${firstWrite} (last done ${lastItem})` : `SKIPS to item ${firstWrite} (last done ${lastItem})`;
  console.log(`  after #${compactionNo}: first action=${first ? `${first.name} ${baseOf(targetOf(first.arguments)).slice(0, 40)}` : 'none'}; ${continuity}`);
  console.log(`     calls=${calls.length} reads=${reads.length} (re-reads of files read before: ${rereads.length}, ${rereadChars} of ${allReadChars} chars; of those still visible in the kept tail = waste: ${wasted.length}, ${wastedChars} chars) orientation calls (TASKS/PROMPT/ls/find)=${orientation.length} repeated writes=${repeated.length} recall tools=${calls.filter(c => c.name.startsWith('session_')).length}`);
  if (firstText) console.log(`     first assistant text: ${JSON.stringify(firstText.trim().slice(0, 140))}`);
}

// ------------------------------------------------------------------------------------------------ cache around each compaction
// cacheReadShare = cacheRead / (input + cacheRead) per assistant message. The first message after a compaction is expected to miss
// (the summary changes the prefix); what matters is how fast the share recovers.
const share = m => { const total = (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0); return total > 0 ? (m.usage?.cacheRead ?? 0) / total : undefined; };
const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN);
const N = 5;
console.log(`
cache read share around each compaction (before = last ${N} turns, after = first turn, then the next ${N}):`);
let n = 0;
for (let s = 0; s < steps.length; s++) {
  if (steps[s].e.type !== 'compaction') continue;
  n++;
  const before = [], after = [];
  for (let k = s - 1; k >= 0 && before.length < N && steps[k].e.type !== 'compaction'; k--) { const v = share(steps[k].e.message); if (v !== undefined) before.push(v); }
  for (let k = s + 1; k < steps.length && after.length < N + 1 && steps[k].e.type !== 'compaction'; k++) { const v = share(steps[k].e.message); if (v !== undefined) after.push(v); }
  console.log(`  #${n}: before=${mean(before).toFixed(3)} first-after=${after.length ? after[0].toFixed(3) : 'n/a'} then=${mean(after.slice(1)).toFixed(3)}`);
}
