import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

/**
 * Keeps one owned section appended to a forced/custom system prompt from another extension. Each call replaces the
 * copy appended last time (or removes it when `section` is undefined) and returns the changed prompt, if any.
 */
export function createForcedPromptAppender() {
  let last: string | undefined;
  return (event: BeforeAgentStartEvent, section: string | undefined): { systemPrompt: string } | undefined => {
    const forced = event.systemPromptOptions.forceSystemPrompt;
    if (forced === undefined) return;
    const base = last ? forced.replace(`\n\n${last}`, '') : forced;
    const prompt = base + (section ? `\n\n${section}` : '');
    last = section;
    if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
  };
}
