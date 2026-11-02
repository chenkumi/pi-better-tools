import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSettingsCommand } from '../../pi-runtime/src/settings-panel/index.js';
import type { Field, Patch, SettingsSchema, Values } from '../../pi-runtime/src/settings-panel/index.js';
import { CONFIG_PATH, parseConfig, type Config, type Provider } from './config.ts';

type CredentialName = 'brave' | 'exa' | 'deepseek';
const PROVIDERS: readonly Provider[] = ['openai', 'native', 'brave', 'exa', 'deepseek'];
const providerIs = (...names: Provider[]) => (v: Values) => names.includes(v.provider as Provider);

function credentialFields(name: CredentialName, label: string, usesPi: boolean): Field[] {
  const only = providerIs(name);
  const sources = usesPi ? ['pi', 'env', 'key'] : ['env', 'key'];
  return [
    { key: `${name}.source`, type: 'enum', group: label, tab: 'Search', label: 'Key source', options: sources, visibleWhen: only,
      help: usesPi ? 'pi: use the DeepSeek login stored by Pi. env: read an environment variable. key: store the key in this file.'
        : 'env: read an environment variable (recommended). key: store the key in this file as plain text.' },
    { key: `${name}.env`, type: 'string', group: label, tab: 'Search', label: 'Env variable name', placeholder: 'e.g. BRAVE_API_KEY', visibleWhen: v => only(v) && v[`${name}.source`] === 'env', help: 'The variable name, not the key itself.' },
    { key: `${name}.key`, type: 'secret', group: label, tab: 'Search', label: 'API key', visibleWhen: v => only(v) && v[`${name}.source`] === 'key', configured: v => v[`${name}.keySet`] === true,
      help: 'Saved as plain text in the web-search file. Leave empty to keep the stored key.' },
  ];
}

const FIELDS: readonly Field[] = [
  { key: 'enabled', type: 'boolean', group: 'Search', tab: 'Search', label: 'web_search enabled' },
  { key: 'provider', type: 'enum', group: 'Search', tab: 'Search', label: 'Provider', options: PROVIDERS, help: 'openai/native use the model\'s own search; brave/exa/deepseek call a REST API.' },
  { key: 'numResults', type: 'int', group: 'Search', tab: 'Search', label: 'Results', min: 1, max: 10 },
  { key: 'searchTimeoutMs', type: 'int', group: 'Search', tab: 'Search', label: 'Search timeout (ms)', min: 1000, max: 120000 },
  { key: 'openai.captureSources', type: 'boolean', group: 'OpenAI', tab: 'Search', label: 'Capture sources', visibleWhen: providerIs('openai'), help: 'Opt-in: keep native search sources for /web-tools sources.' },
  { key: 'google.captureSources', type: 'boolean', group: 'Native (Gemini)', tab: 'Search', label: 'Capture sources', visibleWhen: providerIs('native'), help: 'Opt-in: keep native search sources for /web-tools sources.' },
  ...credentialFields('brave', 'Brave', false),
  ...credentialFields('exa', 'Exa', false),
  ...credentialFields('deepseek', 'DeepSeek', true),
  { key: 'fetch.timeoutMs', type: 'int', group: 'Fetch', tab: 'Fetch', label: 'Timeout (ms)', min: 1000, max: 120000 },
  { key: 'fetch.maxConcurrency', type: 'int', group: 'Fetch', tab: 'Fetch', label: 'Max concurrency', min: 1, max: 4 },
];
/** Panel key -> JSON path for the fields that map one-to-one. Credentials are handled separately. */
const SIMPLE: Record<string, readonly string[]> = {
  enabled: ['enabled'], provider: ['provider'], numResults: ['numResults'], searchTimeoutMs: ['searchTimeoutMs'],
  'openai.captureSources': ['providers', 'openai', 'captureSources'], 'google.captureSources': ['providers', 'google', 'captureSources'],
  'fetch.timeoutMs': ['fetch', 'timeoutMs'], 'fetch.maxConcurrency': ['fetch', 'maxConcurrency'],
};
const NAMES: Record<CredentialName, string> = { brave: 'Brave', exa: 'Exa', deepseek: 'DeepSeek' };

export function webToolsSettings(path = CONFIG_PATH): SettingsSchema<Config> {
  return {
    id: 'web-tools', title: 'Web Tools', path, fields: FIELDS,
    parse: parseConfig,
    afterSave: 'Credentials (if any) are stored as typed; keep this file private.',
    toValues(c) {
      const v: Values = {
        enabled: c.enabled, provider: c.provider, numResults: c.numResults, searchTimeoutMs: c.searchTimeoutMs,
        'openai.captureSources': c.providers.openai.captureSources, 'google.captureSources': c.providers.google.captureSources,
        'fetch.timeoutMs': c.fetch.timeoutMs, 'fetch.maxConcurrency': c.fetch.maxConcurrency,
      };
      for (const name of ['brave', 'exa', 'deepseek'] as const) {
        const cred = c.providers[name];
        v[`${name}.source`] = cred.apiKey ? 'key' : cred.apiKeyEnv ? 'env' : name === 'deepseek' ? 'pi' : 'env';
        v[`${name}.env`] = cred.apiKeyEnv ?? '';
        v[`${name}.keySet`] = !!cred.apiKey; // presence only; the key itself is never loaded into the panel
      }
      return v;
    },
    toPatch(v, dirty, current) {
      const patches: Patch[] = [];
      for (const key of dirty) if (SIMPLE[key]) patches.push({ path: SIMPLE[key], value: v[key] });
      for (const name of ['brave', 'exa', 'deepseek'] as const) {
        if (!providerIs(name)(v) || !(dirty.has(`${name}.source`) || dirty.has(`${name}.env`) || dirty.has(`${name}.key`))) continue;
        const at = (field: string) => ['providers', name, field];
        const source = v[`${name}.source`];
        if (source === 'pi') patches.push({ path: at('apiKey'), value: undefined }, { path: at('apiKeyEnv'), value: undefined });
        else if (source === 'env') {
          const env = String(v[`${name}.env`] ?? '').trim();
          if (!env) return fail(`Enter the environment variable name for ${NAMES[name]} (the name, not the key).`);
          patches.push({ path: at('apiKeyEnv'), value: env }, { path: at('apiKey'), value: undefined });
        } else {
          const typed = typeof v[`${name}.key`] === 'string' ? (v[`${name}.key`] as string).trim() : '';
          if (typed) patches.push({ path: at('apiKey'), value: typed }, { path: at('apiKeyEnv'), value: undefined });
          else if (!current.providers[name].apiKey) return fail(`API key: type the ${NAMES[name]} key, or choose another key source.`);
        }
      }
      return patches;
    },
  };
}
function fail(message: string): never { throw new Error(message); }

export function registerWebToolsSettings(pi: ExtensionAPI): void { registerSettingsCommand(pi, webToolsSettings()); }
