import type { SessionBeforeCompactEvent, SessionBeforeCompactResult } from '@earendil-works/pi-coding-agent';
import type { AutoCompactConfig } from '../config.ts';
import type { EntryRef } from '../fold/ref.ts';
import { asRecord, list, str } from '../fold/util.ts';
import { MAX_ID_PARSE_BYTES, scanLines } from '../session-read/lines.ts';
import { backgroundJobsSection } from '../state/jobs.ts';
import { activeMonitorsSection } from '../state/monitors.ts';
import { workingTreeLines } from '../state/worktree.ts';
import { buildItems, type Entry } from './items.ts';
import { budgetsFor } from './layout.ts';
import { composeSummary, previousWindowStart } from './summary.ts';

/** An image costs about this many characters of context (Pi counts ~1200 tokens at 4 characters). */
const IMAGE_CHARS = 4800;
const ID_HEAD = /^\{"type":"[a-z_]+","id":"([^"]+)"/;

/** Where each entry lives in the session file, read in one streaming pass. Empty when there is no file. */
export async function indexSessionFile(file: string | undefined): Promise<Map<string, EntryRef>> {
  const refs = new Map<string, EntryRef>();
  if (!file) return refs;
  try {
    for await (const item of scanLines(file, 2)) {
      if (item.text === undefined) continue;
      let id = ID_HEAD.exec(item.text.slice(0, 300))?.[1];
      if (!id && item.bytes < MAX_ID_PARSE_BYTES) { try { id = str(asRecord(JSON.parse(item.text))?.id); } catch { /* not an entry */ } }
      if (id) refs.set(id, { line: item.line, id, bytes: item.bytes });
    }
  } catch { /* the summary works without references */ }
  return refs;
}

/** Characters the model will see for one retained entry; only used to count the kept tail against the total ceiling. */
export function keptChars(entry: Entry): number {
  const message = asRecord(entry.message);
  const content = message?.content ?? entry.content;
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const block of list(content)) {
    const b = asRecord(block);
    if (b?.type === 'text') total += str(b.text)?.length ?? 0;
    else if (b?.type === 'image') total += IMAGE_CHARS;
    else if (b?.type === 'toolCall') total += (str(b.name)?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length;
  }
  return total;
}

const CUT_ROLES = new Set(['user', 'assistant', 'bashExecution']);
/** The entries Pi allows as the first kept entry: conversation messages and notes, never a tool result (it would lose its call). */
const isCutPoint = (entry: Entry): boolean => (entry.type === 'message' && CUT_ROLES.has(str(asRecord(entry.message)?.role) ?? '')) || entry.type === 'custom_message' || entry.type === 'branch_summary';

/**
 * L1 ceiling. Pi's cut keeps its own token budget of recent messages, counted at four characters per token, which can be far more
 * real tokens than the user wants to spend on raw history (JSON, code and CJK text run near two characters per token). When the
 * kept tail exceeds `budget` characters the cut moves later, to the first allowed cut point whose tail fits; everything before it
 * goes into the summary. The cut may fall inside a long turn, as Pi's own split-turn cut does. This is pure budget: savepoints and
 * text do not influence it (they only shape the L2/L3 border, see `chooseLayout`), because savepoints can be further apart than the
 * whole budget. If nothing fits, the latest cut point is used, so something stays raw and tool calls keep their results.
 */
export function limitKept(entries: readonly Entry[], cut: number, budget: number): number {
  const tail: number[] = new Array(entries.length + 1).fill(0);
  for (let i = entries.length - 1; i >= 0; i--) tail[i] = tail[i + 1]! + keptChars(entries[i]!);
  if (tail[cut]! <= budget) return cut;
  let latest = cut;
  for (let i = cut + 1; i < entries.length; i++) {
    if (!isCutPoint(entries[i]!)) continue;
    latest = i;
    if (tail[i]! <= budget) return i;
  }
  return latest;
}

export interface HookContext {
  cwd?: string;
  model?: { contextWindow?: number };
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string };
}

/**
 * The `session_before_compact` handler body. Pi keeps ownership of the cut: `firstKeptEntryId` is taken from its preparation
 * and returned unchanged, so everything from there on stays as raw messages (L1) and only the entries before it are summarised.
 * Returns undefined to hand compaction back to Pi.
 */
export async function autoCompact(event: SessionBeforeCompactEvent, ctx: HookContext, config: AutoCompactConfig): Promise<SessionBeforeCompactResult | undefined> {
  const contextWindow = ctx.model?.contextWindow;
  if (typeof contextWindow !== 'number' || !(contextWindow > 0)) return undefined;
  const entries = event.branchEntries as unknown as Entry[];
  const piCut = entries.findIndex(entry => entry.id === event.preparation.firstKeptEntryId);
  if (piCut <= 0) return undefined;
  const cut = limitKept(entries, piCut, budgetsFor(config, contextWindow).l1);
  const refs = await indexSessionFile(ctx.sessionManager.getSessionFile());
  const items = buildItems(entries.slice(0, cut), id => refs.get(id));
  if (items.length === 0) return undefined;
  const sessionId = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
  const volatile = cwd ? [backgroundJobsSection(sessionId, cwd), activeMonitorsSection(sessionId, cwd), (await workingTreeLines(cwd, event.signal)).join('\n')] : [];
  const { summary, details } = composeSummary({
    items, config, contextWindow,
    keptChars: entries.slice(cut).reduce((sum, entry) => sum + keptChars(entry), 0),
    sessionId: refs.size ? sessionId : undefined,
    previousStartEntryId: previousWindowStart(entries),
    volatile,
    cwd,
    cutMoved: cut - piCut,
  });
  return { compaction: { summary, firstKeptEntryId: entries[cut]!.id as string, tokensBefore: event.preparation.tokensBefore, details } };
}
