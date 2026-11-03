import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.ts';

export const AUTO_COMPACT_SECTION = 'pi_better_tools_auto_compact';

/**
 * Fixed text (same bytes every run, so it does not disturb the prompt cache). It tells the agent how the compacted context works
 * and asks for conclusion-first reports, because a long assistant message is shortened in the summary and a short message keeps
 * its beginning. The reporting line is limited to progress reports and final answers so it does not override how the user wants
 * ordinary replies written.
 */
const GUIDANCE = `### Context compaction
- When the conversation grows long, older messages are replaced by a deterministic summary at the start of the context; recent messages stay verbatim. No model writes it, so treat it as an index, not a transcript.
- A summary line ending in ⟦L<line>:<id>⟧ points at the original entry. User messages are kept whole (a pasted block is cut to its head and tail); your own long messages and tool output are shortened or folded. For the original, load the session tools with tool_search "session", then call session_read with the line and id, or session_grep for a keyword.
- Check the summary before reading anything again: do not redo work it shows as done, and re-read a file only when you need its content and it is not visible. Keep going from the next unfinished step.
- When you report progress or finish a task, put the conclusion in the first sentence, then the details: a shortened message keeps only its beginning.`;

/** Adds the section while the compaction of this extension is in effect; an invalid settings file leaves compaction to Pi, so the section is removed. */
export function registerGuidance(pi: ExtensionAPI): void {
  pi.on('before_agent_start', event => {
    const enabled = loadConfig(getAgentDir()).ok;
    const options = event.systemPromptOptions;
    if (enabled) options.sections[AUTO_COMPACT_SECTION] = GUIDANCE;
    else delete options.sections[AUTO_COMPACT_SECTION];
    // Preserve forced/custom prompts from other extensions: they are not built from sections.
    if (options.forceSystemPrompt !== undefined) {
      const base = options.forceSystemPrompt.replace(`\n\n${GUIDANCE}`, '');
      const prompt = base + (enabled ? `\n\n${GUIDANCE}` : '');
      if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
    }
    return undefined;
  });
}
