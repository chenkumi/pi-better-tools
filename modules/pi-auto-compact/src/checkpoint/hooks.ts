import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';
import { asRecord, list, str } from '../fold/util.ts';
import { compactionThreshold } from './threshold.ts';
import { ANCHOR_TOOL, CHECKPOINT_TYPE, checkpointText, CONTINUE_TEXT, CONTINUE_TYPE, isCheckpointType } from './messages.ts';
import { createTracker } from './tracker.ts';

const draft = (customType: string, content: string) => ({ type: 'custom_message' as const, customType, content, display: false });
const hasText = (message: unknown) => list(asRecord(message)?.content).some(block => asRecord(block)?.type === 'text' && (str(asRecord(block)?.text) ?? '').trim() !== '');
const calls = (message: unknown, anchor: boolean) => list(asRecord(message)?.content).filter(block => asRecord(block)?.type === 'toolCall' && (asRecord(block)?.name === ANCHOR_TOOL) === anchor).length;

/**
 * Progress checkpoint for long runs of tool calls: asks for a short report at a turn boundary (once the context grew by a share of the
 * window, or shortly before Pi's compaction threshold, see `tracker.ts`), preferably as a call of the anchor tool
 * (which always returns to the model), otherwise as text, in which case a run that ends right after it is asked once to continue. Both are session entries appended through Pi's own boundary hooks (no steering queue, no timers),
 * so they behave the same in the TUI, RPC children (Fork, Subagent) and print mode. Once a compaction exists they are dropped from
 * the model context; the session file keeps them.
 */
export function registerCheckpoint(pi: ExtensionAPI): void {
  const tracker = createTracker();
  let ratio: number | undefined;
  const refresh = () => { const loaded = loadConfig(getAgentDir()); ratio = loaded.ok ? loaded.config.checkpointRatio : undefined; };
  pi.on('session_start', () => { tracker.reset(); refresh(); });
  pi.on('session_compact', () => tracker.compacted());
  pi.on('before_agent_start', event => { if (event.messageType === 'user') tracker.reset(); });
  /** Pi's compaction threshold for the current model, or null when it cannot be known (settings unreadable or invalid, compaction off, window unknown). */
  const threshold = (ctx: { model?: { provider: string; id: string; contextWindow?: number } }): number | null => {
    try { return compactionThreshold(pi.getSettings(), ctx.model) ?? null; } catch { return null; }
  };
  pi.on('turn_end', (event, ctx) => {
    if (ratio === undefined) return undefined;
    const action = tracker.turnEnd({ tokens: ctx.getContextUsage()?.tokens ?? null, contextWindow: ctx.model?.contextWindow ?? 0, hasText: hasText(event.message), anchored: calls(event.message, true) > 0, toolCalls: calls(event.message, false), threshold: threshold(ctx) }, ratio);
    return action === 'checkpoint' ? { entries: [...event.entries, draft(CHECKPOINT_TYPE, checkpointText(pi.getActiveTools().includes(ANCHOR_TOOL)))], continue: true } : undefined;
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
