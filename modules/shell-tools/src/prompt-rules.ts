import { FILE_INSPECT_TOOLS, SHELL_TOOLS, WEB_TOOLS } from '../../../shared/src/contracts/index.js';

export const SHELL_RULES_SECTION = 'shell_rules';

/** Rules about using the shell itself. The first applies only when a dedicated tool exists to be circumvented. */
export function renderShellRules(active: ReadonlySet<string>): string | undefined {
  if (!SHELL_TOOLS.some(name => active.has(name))) return undefined;
  const blocks: string[] = [];
  if ([...FILE_INSPECT_TOOLS, ...WEB_TOOLS].some(name => active.has(name))) {
    blocks.push('- Never use the shell to get around what a dedicated tool refuses (confirmation, allowlist, private-address or size limits).');
  }
  blocks.push('**Verify before claiming**\n- Run the project\'s real checks and read their output before saying something works. Report what was verified and what was not.');
  return blocks.join('\n\n');
}
