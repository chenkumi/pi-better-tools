import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { asRecord, list, num, str } from '../fold/util.ts';
import { compactionThreshold } from './threshold.ts';
import { CHECKPOINT_TOOL, CONTINUE_TEXT, CONTINUE_TYPE, DEADLINE_TYPE, deadlineText, isCheckpointType } from './messages.ts';
import { createTracker } from './tracker.ts';

const draft = (customType: string, content: string) => ({ type: 'custom_message' as const, customType, content, display: false });
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
const toolCallNames = (message: unknown) => list(asRecord(message)?.content).map(asRecord).filter(block => block?.type === 'toolCall').map(block => block?.name);

/**
 * Shortly before Pi's compaction threshold (the deadline, see `tracker.ts`) it appends a notice that guides the agent to save a
 * progress checkpoint, a call of the checkpoint tool whose `summary` stays in the conversation (the compaction summary shows the
 * latest one in full); that is guidance, not a forced call. A text-only answer that ends the run is asked once to continue. Both
 * messages are session entries appended through Pi's own boundary hooks (no steering queue, no timers), so they behave the same in
 * the TUI, RPC children (Fork, Subagent) and print mode. Once a compaction exists they are dropped from the model context; the
 * session file keeps them.
 */
export function registerCheckpoint(pi: ExtensionAPI): void {
  const tracker = createTracker();
  let enabled = false;
  let marginMinTokens: number | undefined;
  const refresh = () => {
    const loaded = loadConfig(getAgentDir());
    enabled = loaded.ok;
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
    if (!enabled) return undefined;
    const names = toolCallNames(event.message);
    const action = tracker.turnEnd({
      tokens: ctx.getContextUsage()?.tokens ?? null,
      reportedTokens: reportedTokens(event.message),
      contextWindow: ctx.model?.contextWindow ?? 0,
      checkpointed: names.includes(CHECKPOINT_TOOL),
      toolCalls: names.length,
      threshold: threshold(ctx),
      hasTool: pi.getActiveTools().includes(CHECKPOINT_TOOL),
      marginMinTokens,
    });
    if (action === 'none') return undefined;
    return { entries: [...event.entries, draft(DEADLINE_TYPE, deadlineText())], continue: true };
  });
  pi.on('agent_before_settle', event => {
    if (!enabled || !tracker.shouldContinue()) return undefined;
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
