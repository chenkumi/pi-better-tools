import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { bottomConfirm } from '../bottom-panel/dialogs.ts';
import { isBottomPanelOpen, openBottomPanel } from '../bottom-panel/host.ts';
import { SettingsInputError } from './errors.ts';
import { SettingsPanel } from './panel.ts';
import type { SettingsSchema, Values } from './schema.ts';
import { applyPatches, readRaw, removeFile, writeJsonAtomic } from './store.ts';

/** A schema, or a function that picks one per invocation. A returned string refuses with that message (for example untrusted project). */
export type SchemaSource<C> = SettingsSchema<C> | ((ctx: ExtensionCommandContext) => SettingsSchema<C> | string | Promise<SettingsSchema<C> | string>);

/**
 * Registers `/settings:<id>`. The file is only written when the user presses Save in the panel; loading the extension never
 * touches it. A bare `/settings` is deliberately not registered (it is Pi's own command).
 */
export function registerSettingsCommand<C>(pi: ExtensionAPI, source: SchemaSource<C>, meta?: { id: string; title: string }): void {
  const id = typeof source === 'function' ? meta!.id : source.id, title = typeof source === 'function' ? meta!.title : source.title;
  pi.registerCommand(`settings:${id}`, {
    description: `Edit ${title} settings in a panel`,
    handler: async (_args, ctx) => {
      const schema = typeof source === 'function' ? await source(ctx) : source;
      if (typeof schema === 'string') { if (ctx.hasUI) ctx.ui.notify(schema, 'warning'); return; }
      await open(schema, ctx);
    },
  });
}

async function open<C>(schema: SettingsSchema<C>, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') { if (ctx.hasUI) ctx.ui.notify(`The settings panel needs the interactive TUI. Edit ${schema.path} directly.`, 'warning'); return; }
  const first = readRaw(schema.path);
  let startFresh = false;
  if (first.state === 'invalid') {
    startFresh = await bottomConfirm(ctx, `${schema.title} settings`, `The existing file is unusable (${first.reason}). Start from defaults? Saving replaces the file.`);
    if (!startFresh) return;
  }
  let current: C;
  try { current = schema.parse(first.state === 'invalid' ? {} : first.raw); }
  catch (error) {
    startFresh = await bottomConfirm(ctx, `${schema.title} settings`, `${message(error)}. Start from defaults? Saving replaces the file.`);
    if (!startFresh) return;
    current = schema.parse({});
  }
  const values = schema.toValues(current);

  const save = (edited: Values, dirty: ReadonlySet<string>) => saveSettings(schema, edited, dirty, startFresh);

  if (isBottomPanelOpen()) { ctx.ui.notify('Another panel is open. Close it first, then run this command again.', 'warning'); return; }
  let panel: SettingsPanel | undefined;
  const saved = await openBottomPanel<boolean>(ctx.ui, {
    key: 'pi-better-tools-settings',
    title: () => panel?.title ?? schema.title,
    create: ({ done, theme, rows, requestRender }) => panel = new SettingsPanel({
      title: schema.title, notice: schema.notice,
      fields: schema.fields, values, style: theme, ...(schema.unsaved ? { unsaved: schema.unsaved } : {}),
      rows, requestRender,
      onSave: save,
      onClose: done,
    }),
  });
  if (!saved) return; // cancelled, or closed from outside (reload, session switch)
  ctx.ui.notify(`Saved ${schema.path}.${schema.afterSave ? ` ${schema.afterSave}` : ''}`, 'info');
  if (schema.appliesWithoutReload) return;
  if (await bottomConfirm(ctx, `${schema.title} settings`, 'Settings are read when extensions load. Reload now?')) await ctx.reload();
  else ctx.ui.notify('Run /reload to apply the new settings.', 'info');
}

/**
 * What Save does: re-read the file so edits made elsewhere while the panel was open are kept, apply only the changed keys,
 * validate the whole document, write atomically, then run the schema's effects outside the file. Returns an error text, or
 * undefined on success.
 */
export async function saveSettings<C>(schema: SettingsSchema<C>, edited: Values, dirty: ReadonlySet<string>, startFresh = false): Promise<string | undefined> {
  const latest = readRaw(schema.path);
  if (latest.state === 'invalid' && !startFresh) return `The file became unusable (${latest.reason}); close the panel and fix it first.`;
  const raw = latest.state === 'invalid' ? {} : latest.raw;
  try {
    const base = startFresh ? {} : raw;
    const patches = schema.toPatch(edited, dirty, schema.parse(base));
    const next = applyPatches(base, patches);
    schema.parse(next);
    // Nothing to change in the file (for example only a credential kept elsewhere was edited): leave it untouched.
    if (patches.length || startFresh) {
      if (schema.deleteWhenEmpty && !Object.keys(next).length) removeFile(schema.path); else writeJsonAtomic(schema.path, next);
    }
    const failed = await schema.afterWrite?.(edited, dirty);
    if (failed) return failed;
  } catch (error) { return message(error); }
  return undefined;
}

/**
 * Shown as is: a `SettingsInputError` (a module opts in for input it wrote for the user), a config parse error (`CONFIG_INVALID`,
 * which never carries values) and the store's own write errors. Anything else is reduced to a generic line.
 */
function message(error: unknown): string {
  if (error instanceof SettingsInputError) return error.message;
  const text = error instanceof Error ? error.message : '';
  return /^(CONFIG_INVALID|cannot write|configuration path)/.test(text) ? text : 'the settings could not be validated';
}
