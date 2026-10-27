import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

/**
 * `/theme:<id>` switches the Pi theme. The shipped themes live in ../themes/ and are declared as package theme resources
 * (root package.json `pi.themes`), so they exist before the UI starts and a persisted choice still resolves on the next launch.
 * `dark` and `light` are Pi's own built-in themes, offered so there is always a way back.
 * `/theme:menu` opens a picker. A bare `/theme` is deliberately not registered: it collides with Pi's own commands.
 */
export const THEMES = [
  { id: 'deep-sea', theme: 'pi-better-deep-sea', summary: 'cool cyan-blue, restrained status colors' },
  { id: 'warm-charcoal', theme: 'pi-better-warm-charcoal', summary: 'warm grey, coral accent, easy on the eyes' },
  { id: 'moss', theme: 'pi-better-moss', summary: 'green terminal feel, orange-red errors' },
  { id: 'quiet', theme: 'pi-better-quiet', summary: 'cards close to the background, one soft accent' },
  { id: 'signal', theme: 'pi-better-signal', summary: 'high contrast, saturated status colors' },
  { id: 'paper', theme: 'pi-better-paper', summary: 'for light terminals' },
  { id: 'dark', theme: 'dark', summary: 'Pi built-in dark (the default look)' },
  { id: 'light', theme: 'light', summary: 'Pi built-in light' },
] as const;
type Entry = (typeof THEMES)[number];

const list = () => THEMES.map(entry => entry.id).join(', ');

/**
 * Switching by name is what /settings does: Pi stores the choice in the user's settings, so it survives a restart.
 * This only runs when the user types the command; loading the extension never touches settings.
 */
function apply(ctx: ExtensionCommandContext, entry: Entry) {
  if (!ctx.hasUI) return;
  let result: { success: boolean; error?: string };
  try { result = ctx.ui.setTheme(entry.theme); }
  catch (error) { result = { success: false, error: error instanceof Error ? error.message : String(error) }; }
  if (result.success) ctx.ui.notify(`Theme: ${entry.id}`, 'info');
  else ctx.ui.notify(`Theme "${entry.id}" was not applied: ${result.error ?? 'unknown error'}. Available: ${list()}`, 'warning');
}

export default function themeTools(pi: ExtensionAPI) {
  for (const entry of THEMES) {
    pi.registerCommand(`theme:${entry.id}`, {
      description: `Switch to the ${entry.id} theme (${entry.summary})`,
      handler: async (_args, ctx) => apply(ctx, entry),
    });
  }
  pi.registerCommand('theme:menu', {
    description: 'Pick a theme from a menu',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const current = ctx.ui.theme?.name;
      const labels = THEMES.map(entry => `${entry.id}${entry.theme === current ? ' (current)' : ''} — ${entry.summary}`);
      const picked = await ctx.ui.select('Theme', labels);
      const entry = picked === undefined ? undefined : THEMES[labels.indexOf(picked)];
      if (entry) apply(ctx, entry);
    },
  });
}
