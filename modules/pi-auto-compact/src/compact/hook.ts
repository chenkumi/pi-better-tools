import type { SessionBeforeCompactEvent, SessionBeforeCompactResult } from '@earendil-works/pi-coding-agent';
import type { AutoCompactConfig } from '../config.ts';
import type { EntryRef } from '../fold/ref.ts';
import { asRecord, list, str } from '../fold/util.ts';
import { scanLines } from '../session-read/lines.ts';
import { buildItems, type Entry } from './items.ts';
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
      if (!id && item.bytes < 1024 * 1024) { try { id = str(asRecord(JSON.parse(item.text))?.id); } catch { /* not an entry */ } }
      if (id) refs.set(id, { line: item.line, id, bytes: item.bytes });
    }
  } catch { /* the summary works without references */ }
  return refs;
}

/** Characters the model will see for one retained entry; only used to count the kept tail against the total ceiling. */
function keptChars(entry: Entry): number {
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

export interface HookContext {
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
  const cut = entries.findIndex(entry => entry.id === event.preparation.firstKeptEntryId);
  if (cut <= 0) return undefined;
  const refs = await indexSessionFile(ctx.sessionManager.getSessionFile());
  const items = buildItems(entries.slice(0, cut), id => refs.get(id));
  if (items.length === 0) return undefined;
  const { summary, details } = composeSummary({
    items, config, contextWindow,
    keptChars: entries.slice(cut).reduce((sum, entry) => sum + keptChars(entry), 0),
    sessionId: refs.size ? ctx.sessionManager.getSessionId() : undefined,
    previousStartEntryId: previousWindowStart(entries),
  });
  return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details } };
}
