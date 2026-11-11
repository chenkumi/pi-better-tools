import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { SettingsInputError, registerSettingsCommand } from '../../../shared/src/settings-panel/index.ts';
import type { Field, Patch, SettingsSchema, Values } from '../../../shared/src/settings-panel/index.ts';
import { describeLogin, resolveApiKey, type KeyResolver } from './auth.ts';
import { codexPreflight, type CodexEnv } from './backends/codex.ts';
import { BACKENDS, BACKEND_LABELS, CONFIG_PATH, CONFIRM_MODES, MAX_IMAGES_RANGE, OPENAI_FORMATS, OPENAI_QUALITIES, RESOLUTIONS, TIMEOUT_MS_RANGE, parseConfig, type Config } from './config.ts';
import { ToolError } from '../../../shared/src/tool-error/index.ts';

const GENERAL = 'General';
const baseFields: readonly Field[] = [
  { key: 'enabled', type: 'boolean', group: GENERAL, tab: GENERAL, label: 'Enabled', help: 'Master switch. Off: image_generate is refused and, after /reload, no longer registered. Turning it on again after a start with it off needs /reload.' },
  { key: 'backend', type: 'enum', group: GENERAL, tab: GENERAL, label: 'Default backend', options: BACKENDS, help: 'Used when image_generate is called without a backend. There is no automatic fallback between backends.' },
  { key: 'confirm', type: 'enum', group: GENERAL, tab: GENERAL, label: 'Confirm paid requests', options: CONFIRM_MODES, help: 'first: ask once per session and backend. always: ask every time. never: do not ask (also the only way a Fork, which has no UI, can generate).' },
  { key: 'outputDir', type: 'string', group: GENERAL, tab: GENERAL, label: 'Output directory', placeholder: '.pi/generated-images', help: 'Inside the project, relative. Images are only added here, never replaced.' },
  { key: 'maxImages', type: 'int', group: GENERAL, tab: GENERAL, label: 'Max images per call', ...MAX_IMAGES_RANGE },
  { key: 'inlinePreview', type: 'boolean', group: GENERAL, tab: GENERAL, label: 'Return a preview to the model', help: 'Attach the first image (up to 4 MiB) to the tool result. Costs image tokens.' },
  { key: 'timeoutMs', type: 'int', group: GENERAL, tab: GENERAL, label: 'API timeout (ms)', ...TIMEOUT_MS_RANGE },
  { key: 'openai.enabled', type: 'boolean', group: 'OpenAI', tab: 'OpenAI', label: 'Enabled' },
  { key: 'openai.model', type: 'string', group: 'OpenAI', tab: 'OpenAI', label: 'Model', placeholder: 'gpt-image-2.6-sunburst', help: 'Any Images API model id. The key is the API key stored in Pi for provider openai (an OAuth/ChatGPT login does not work).' },
  { key: 'openai.quality', type: 'enum', group: 'OpenAI', tab: 'OpenAI', label: 'Quality', options: OPENAI_QUALITIES },
  { key: 'openai.format', type: 'enum', group: 'OpenAI', tab: 'OpenAI', label: 'Format', options: OPENAI_FORMATS },
  { key: 'gemini.enabled', type: 'boolean', group: 'Gemini', tab: 'Gemini', label: 'Enabled' },
  { key: 'gemini.model', type: 'string', group: 'Gemini', tab: 'Gemini', label: 'Model', placeholder: 'gemini-nano-banana-2.1', help: 'The key is the API key stored in Pi for provider google. Gemini returns JPEG only.' },
  { key: 'gemini.resolution', type: 'enum', group: 'Gemini', tab: 'Gemini', label: 'Resolution', options: RESOLUTIONS },
  { key: 'codex.enabled', type: 'boolean', group: 'Codex CLI', tab: 'Codex', label: 'Enabled' },
  { key: 'codex.path', type: 'string', group: 'Codex CLI', tab: 'Codex', label: 'Executable', placeholder: 'codex', help: 'The codex executable (not a .cmd/.bat shim). Needs a ChatGPT login: run "codex login" in a terminal.' },
  { key: 'codex.model', type: 'string', group: 'Codex CLI', tab: 'Codex', label: 'Model (optional)', placeholder: 'Codex default', help: 'Empty keeps the Codex default.' },
  { key: 'codex.timeoutMs', type: 'int', group: 'Codex CLI', tab: 'Codex', label: 'Run timeout (ms)', ...TIMEOUT_MS_RANGE },
];

/** Panel key -> JSON path for the fields that map one to one. `codex.model` is handled apart (empty removes the key). */
const SIMPLE: Record<string, readonly string[]> = {
  enabled: ['enabled'], backend: ['backend'], confirm: ['confirm'], outputDir: ['outputDir'], maxImages: ['maxImages'], inlinePreview: ['inlinePreview'], timeoutMs: ['timeoutMs'],
  'openai.enabled': ['openai', 'enabled'], 'openai.model': ['openai', 'model'], 'openai.quality': ['openai', 'quality'], 'openai.format': ['openai', 'format'],
  'gemini.enabled': ['gemini', 'enabled'], 'gemini.model': ['gemini', 'model'], 'gemini.resolution': ['gemini', 'resolution'],
  'codex.enabled': ['codex', 'enabled'], 'codex.path': ['codex', 'path'], 'codex.timeoutMs': ['codex', 'timeoutMs'],
};

export interface SettingsDeps { key?: KeyResolver; codex?: Pick<CodexEnv, 'spawnImpl' | 'argsPrefix' | 'codexHome' | 'tmpRoot' | 'baseEnv'> }

export function imageGenerationSettings(ctx: Pick<ExtensionCommandContext, 'cwd'> & Record<string, unknown>, deps: SettingsDeps = {}, path = CONFIG_PATH): SettingsSchema<Config> {
  const key = deps.key ?? resolveApiKey;
  const checkLogin = (backend: 'openai' | 'gemini'): Field => ({
    key: `${backend}.check`, type: 'action', group: BACKEND_LABELS[backend], tab: BACKEND_LABELS[backend] === 'OpenAI' ? 'OpenAI' : 'Gemini', label: 'Pi login', confirm: `Check the ${BACKEND_LABELS[backend]} API key stored in Pi? Nothing is sent to the provider.`,
    status: () => 'Enter to check',
    run: async () => describeLogin(ctx as never, backend, key),
  });
  const checkCodex: Field = {
    key: 'codex.check', type: 'action', group: 'Codex CLI', tab: 'Codex', label: 'Codex CLI', confirm: 'Run "codex login status"? It only reads the login state.',
    status: () => 'Enter to check',
    run: async () => {
      try { await codexPreflight(parseConfig({ codex: {} }).codex, { timeoutMs: 20_000, ...deps.codex }); return 'installed and logged in'; }
      catch (error) { return error instanceof ToolError ? error.message.replace(/^IMAGE_[A-Z_]+: /, '') : 'could not check'; }
    },
  };
  const fields: Field[] = [];
  for (const field of baseFields) {
    fields.push(field);
    if (field.key === 'openai.format') fields.push(checkLogin('openai'));
    if (field.key === 'gemini.resolution') fields.push(checkLogin('gemini'));
    if (field.key === 'codex.timeoutMs') fields.push(checkCodex);
  }
  return {
    id: 'image-generation', title: 'Image Generation', path, fields,
    parse: parseConfig,
    appliesWithoutReload: true,
    afterSave: 'The next image_generate call uses it (turning it on after a start with it off needs /reload). Keys are never stored here: they stay in Pi (/login).',
    toValues(c) {
      return {
        enabled: c.enabled, backend: c.backend, confirm: c.confirm, outputDir: c.outputDir, maxImages: c.maxImages, inlinePreview: c.inlinePreview, timeoutMs: c.timeoutMs,
        'openai.enabled': c.openai.enabled, 'openai.model': c.openai.model, 'openai.quality': c.openai.quality, 'openai.format': c.openai.format,
        'gemini.enabled': c.gemini.enabled, 'gemini.model': c.gemini.model, 'gemini.resolution': c.gemini.resolution,
        'codex.enabled': c.codex.enabled, 'codex.path': c.codex.path, 'codex.model': c.codex.model ?? '', 'codex.timeoutMs': c.codex.timeoutMs,
      } satisfies Values;
    },
    toPatch(v, dirty): Patch[] {
      const patches: Patch[] = [];
      for (const name of dirty) if (SIMPLE[name]) patches.push({ path: SIMPLE[name]!, value: typeof v[name] === 'string' ? (v[name] as string).trim() : v[name] });
      if (dirty.has('codex.model')) patches.push({ path: ['codex', 'model'], value: String(v['codex.model'] ?? '').trim() || undefined });
      return patches;
    },
  };
}
export const settingsError = (message: string): never => { throw new SettingsInputError(message); };

export function registerImageGenerationSettings(pi: ExtensionAPI, deps: SettingsDeps = {}, path = CONFIG_PATH): void {
  registerSettingsCommand(pi, ctx => imageGenerationSettings(ctx as never, deps, path), { id: 'image-generation', title: 'Image Generation' });
}
