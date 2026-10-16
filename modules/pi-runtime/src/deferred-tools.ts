import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Shared handling for this package's deferred tools. A module only declares `exposure: "deferred"` and a `namespace`
 * on its tools; it needs no activation or prompt code of its own.
 *
 * - Fresh sessions (`startup`/`new`) with a registered but inactive `tool_search` get it activated, so deferred tools
 *   load on demand without any `defaultTools` setting. Resume/fork restore the recorded tool set and reload keeps the
 *   current one, so neither is touched.
 * - Without a registered `tool_search` (for example filtered out by `--tools`), the package's deferred tools are
 *   declared directly, which is the behavior before they were deferred.
 * - While `tool_search` is active, one prompt section lists each namespace that still has unloaded tools.
 */
export const DEFERRED_SECTION = 'pi_better_tools_deferred_tools';
const TOOL_SEARCH = 'tool_search';
// modules/pi-runtime/src -> modules/. Only tools registered from this package's modules are managed.
const norm = (path: string) => path.split('\\').join('/').toLowerCase();
const OWN = norm(fileURLToPath(new URL('../../', import.meta.url)));

export function registerDeferredTools(pi: ExtensionAPI): void {
  let last: string | undefined;
  const managed = () => pi.getAllTools().filter(tool => tool.exposure === 'deferred' && tool.namespace && norm(tool.sourceInfo?.path ?? '').startsWith(OWN));
  const render = (active: Set<string>): string | undefined => {
    const groups = new Map<string, string>();
    for (const tool of managed()) if (!active.has(tool.name) && tool.namespace && !groups.has(tool.namespace.name)) groups.set(tool.namespace.name, tool.namespace.description ?? '');
    if (!groups.size) return undefined;
    const lines = [...groups].map(([name, description]) => `- ${name}${description ? `: ${description}` : ''} (query "${name}")`);
    return `### Deferred tools\nThese tool groups are not loaded yet. Call tool_search with the query shown to load a group before using it:\n${lines.join('\n')}`;
  };

  pi.on('session_start', event => {
    if (event.reason !== 'startup' && event.reason !== 'new') return;
    const active = pi.getActiveTools();
    const pending = managed().filter(tool => !active.includes(tool.name));
    if (!pending.length || active.includes(TOOL_SEARCH)) return;
    if (pi.getAllTools().some(tool => tool.name === TOOL_SEARCH)) pi.setActiveTools([...active, TOOL_SEARCH]);
    else pi.setActiveTools([...new Set([...active, ...pending.map(tool => tool.name)])]);
  });

  pi.on('before_agent_start', event => {
    const options = event.systemPromptOptions;
    const active = new Set(pi.getActiveTools());
    const section = active.has(TOOL_SEARCH) ? render(active) : undefined;
    if (section) options.sections[DEFERRED_SECTION] = section;
    else delete options.sections[DEFERRED_SECTION];
    // Preserve forced/custom prompts from other extensions.
    if (options.forceSystemPrompt === undefined) return;
    const base = last ? options.forceSystemPrompt.replace(`\n\n${last}`, '') : options.forceSystemPrompt;
    const prompt = base + (section ? `\n\n${section}` : '');
    last = section;
    if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
  });
}
