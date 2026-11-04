import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

/**
 * Keeps one owned section appended to a forced/custom system prompt from another extension. Each call replaces the
 * copy appended last time (or removes it when `section` is undefined) and returns the changed prompt, if any.
 *
 * `knownSections` lists fixed texts that are always stripped before appending. Pass it when the same section is
 * registered by more than one extension (or twice): a hook that does not remember what another instance appended
 * would otherwise append it again when the host feeds the changed prompt back as the forced prompt.
 */
export function createForcedPromptAppender(knownSections: readonly string[] = []) {
  let last: string | undefined;
  return (event: BeforeAgentStartEvent, section: string | undefined): { systemPrompt: string } | undefined => {
    const forced = event.systemPromptOptions.forceSystemPrompt;
    if (forced === undefined) return;
    let base = forced;
    for (const text of last ? [last, ...knownSections] : knownSections) base = base.replace(`\n\n${text}`, '');
    const prompt = base + (section ? `\n\n${section}` : '');
    last = section;
    if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
  };
}
