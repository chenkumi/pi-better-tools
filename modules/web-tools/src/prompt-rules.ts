import { SHELL_TOOLS, WEB_TOOLS } from '../../../shared/src/contracts/index.ts';

export const WEB_RULES_SECTION = 'web_rules';

/** Prefer the web tools over `curl`/`wget` while a shell tool is active. */
export function renderWebRules(active: ReadonlySet<string>): string | undefined {
  if (!SHELL_TOOLS.some(name => active.has(name))) return undefined;
  const web = WEB_TOOLS.filter(name => active.has(name)).map(name => `\`${name}\``).join('/');
  return web ? `- Use ${web} for web content, not \`curl\`/\`wget\`.` : undefined;
}
