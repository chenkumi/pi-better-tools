import { FILE_EDIT_TOOLS, FILE_INSPECT_TOOLS, SHELL_TOOLS } from '../../../shared/src/contracts/index.ts';

export const FILE_RULES_SECTION = 'file_rules';

/** Rules for the file tools next to the shell. They matter only while a shell tool is active. */
export function renderFileRules(active: ReadonlySet<string>): string | undefined {
  if (!SHELL_TOOLS.some(name => active.has(name))) return undefined;
  const inspect = FILE_INSPECT_TOOLS.filter(name => active.has(name)).map(name => `\`${name}\``).join('/');
  const blocks: string[] = [];
  if (inspect) blocks.push(`**Dedicated tools over the shell**\n- Look at the workspace with ${inspect}, not shell \`cat\`/\`rg\`/\`find\`/\`ls\`: search first, then read only the ranges you need.`);
  if (FILE_EDIT_TOOLS.some(name => active.has(name))) {
    blocks.push('**Files and shell**\n- This is a rule for local files on this machine (the local workspace), not for remote hosts or other targets. Change local files with `edit`/`write`, never through shell redirection, `sed`, or one-off scripts (`node -e`, `perl -i`): editing a file from the shell bypasses the edit/write version-token guard and is a rule violation. Use the shell for builds, tests, git and pipelines.');
  }
  return blocks.length ? blocks.join('\n\n') : undefined;
}
