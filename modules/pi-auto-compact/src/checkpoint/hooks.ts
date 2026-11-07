import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { asRecord, list, num, str } from '../fold/util.ts';
import { compactionThreshold } from './threshold.ts';
import { ANCHOR_TOOL, CHECKPOINT_TYPE, checkpointText, CONTINUE_TEXT, CONTINUE_TYPE, DEADLINE_TYPE, deadlineText, isCheckpointType, NOTE_TOOL, WRITE_TOOLS } from './messages.ts';
import { createTracker } from './tracker.ts';

const draft = (customType: string, content: string) => ({ type: 'custom_message' as const, customType, content, display: false });
const hasText = (message: unknown) => list(asRecord(message)?.content).some(block => asRecord(block)?.type === 'text' && (str(asRecord(block)?.text) ?? '').trim() !== '');
/**
 * Context size the provider reported for an assistant response, counted the way Pi counts it (`totalTokens`, else the sum of the
 * parts). Null for an error or aborted response and when no usage was reported.
 */
function reportedTokens(message: unknown): number | null {
  const record = asRecord(message);
  if (record?.stopReason === 'error' || record?.stopReason === 'aborted') return null;
  const usage = asRecord(record?.usage);
  const total = num(usage?.totalTokens) || (num(usage?.input) ?? 0) + (num(usage?.output) ?? 0) + (num(usage?.cacheRead) ?? 0) + (num(usage?.cacheWrite) ?? 0);
  return total > 0 ? total : null;
}
const toolCallNames =(message: unknown) => list(asRecord(message)?.content).map(asRecord).filter(block => block?.type === 'toolCall').map(block => block?.name);
const anchorCalls = (message: unknown) => toolCallNames(message).filter(name => name === ANCHOR_TOOL).length;
/** Tool calls other than the anchor tool. */
const otherCalls = (message: unknown) => toolCallNames(message).length - anchorCalls(message);

/**
 * Shortly before Pi's compaction threshold (the deadline, see `tracker.ts`) it also appends a notice that guides the agent to save its
 * progress to a notes file (the `note` tool when active, otherwise any file it can write); that is guidance, not a required tool call.
 *
 * Progress checkpoint for long runs of tool calls: asks for a short report at a turn boundary (once the context grew by a share of the
 * window, see `tracker.ts`), preferably as a call of the anchor tool
 * (which always returns to the model), otherwise as text, in which case a run that ends right after it is asked once to continue. Both are session entries appended through Pi's own boundary hooks (no steering queue, no timers),
 * so they behave the same in the TUI, RPC children (Fork, Subagent) and print mode. Once a compaction exists they are dropped from
 * the model context; the session file keeps them.
 */
export function registerCheckpoint(pi: ExtensionAPI): void {
  const tracker = createTracker();
  let ratio: number | undefined;
  let minTokens = 0;
  let marginMinTokens: number | undefined;
  const refresh = () => {
    const loaded = loadConfig(getAgentDir());
    ratio = loaded.ok ? loaded.config.checkpointRatio : undefined;
    minTokens = loaded.ok ? loaded.config.checkpointMinTokens : 0;
    marginMinTokens = loaded.ok ? loaded.config.deadlineMarginMinTokens : undefined;
  };
  pi.on('session_start', () => { tracker.restart(); refresh(); });
  pi.on('session_compact', () => tracker.compacted());
  pi.on('before_agent_start', event => { if (event.messageType === 'user') { tracker.reset(); refresh(); } });
  /** Pi's compaction threshold for the current model, or null when it cannot be known (settings unreadable or invalid, compaction off, window unknown). */
  const threshold = (ctx: { model?: { provider: string; id: string; contextWindow?: number } }): number | null => {
    try { return compactionThreshold(pi.getSettings(), ctx.model) ?? null; } catch { return null; }
  };
  pi.on('turn_end', (event, ctx) => {
    if (ratio === undefined) return undefined;
    const active = pi.getActiveTools();
    const action = tracker.turnEnd({
      tokens: ctx.getContextUsage()?.tokens ?? null,
      reportedTokens: reportedTokens(event.message),
      contextWindow: ctx.model?.contextWindow ?? 0,
      hasText: hasText(event.message),
      anchored: anchorCalls(event.message) > 0,
      toolCalls: otherCalls(event.message),
      threshold: threshold(ctx),
      canWrite: WRITE_TOOLS.some(name => active.includes(name)),
      marginMinTokens,
    }, ratio, minTokens);
    if (action === 'none') return undefined;
    const entry = action === 'deadline' ? draft(DEADLINE_TYPE, deadlineText(WRITE_TOOLS.filter(name => active.includes(name)))) : draft(CHECKPOINT_TYPE, checkpointText(active.includes(ANCHOR_TOOL)));
    return { entries: [...event.entries, entry], continue: true };
  });
  pi.on('agent_before_settle', event => {
    if (ratio === undefined || !tracker.shouldContinue()) return undefined;
    return { entries: [...event.entries, draft(CONTINUE_TYPE, CONTINUE_TEXT)], continue: true };
  });
  pi.on('context', (event, ctx) => {
    if (!ctx.sessionManager.getBranch().some(entry => entry.type === 'compaction')) return undefined;
    let lastAssistant = -1;
    event.messages.forEach((message, index) => { if (message.role === 'assistant') lastAssistant = index; });
    const kept = event.messages.filter((message, index) => !(message.role === 'custom' && isCheckpointType((message as { customType?: unknown }).customType) && index < lastAssistant));
    return kept.length === event.messages.length ? undefined : { messages: kept };
  });
}
