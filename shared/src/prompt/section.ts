import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createForcedPromptAppender } from './forced-prompt.js';

/**
 * Owns one structured system-prompt section. `render` receives the active tool names for this run and returns the
 * section text, or undefined to remove the section. Under a forced/custom prompt, which is not built from sections,
 * the same text is appended to it. Call this from the owning module's entry; importing it registers nothing.
 */
export function registerPromptSection(pi: ExtensionAPI, key: string, render: (active: ReadonlySet<string>) => string | undefined): void {
  const appendToForcedPrompt = createForcedPromptAppender();
  pi.on('before_agent_start', event => {
    const section = render(new Set(pi.getActiveTools()));
    const { sections } = event.systemPromptOptions;
    if (section) sections[key] = section; else delete sections[key];
    return appendToForcedPrompt(event, section);
  });
}
