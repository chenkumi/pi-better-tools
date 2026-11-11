import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ToolError } from '../../../shared/src/tool-error/index.ts';
import { BACKEND_LABELS, type Backend } from './config.ts';

/** The Pi provider whose login a backend uses. */
export const PI_PROVIDER: Record<'openai' | 'gemini', string> = { openai: 'openai', gemini: 'google' };

interface RegistryLike {
  getAll?(): Array<{ provider: string }>;
  isUsingOAuth?(model: never): boolean;
  getProviderAuth?(provider: string): Promise<{ auth?: { apiKey?: string }; source?: string } | undefined>;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}
export type KeyResolver = (ctx: ExtensionContext, backend: 'openai' | 'gemini') => Promise<string>;

const missing = (backend: 'openai' | 'gemini', why: string) => new ToolError('IMAGE_AUTH_MISSING', `${BACKEND_LABELS[backend]} needs an API key login in Pi (/login, provider "${PI_PROVIDER[backend]}"): ${why}`);

/**
 * The provider API key Pi holds for this backend, resolved at request time. An OAuth login (for example ChatGPT) is not an API
 * key: it is refused before anything is resolved, so it is never refreshed here and never sent to the provider's API.
 * Nothing from the environment or the project is read.
 */
export const resolveApiKey: KeyResolver = async (ctx, backend) => {
  const registry = (ctx as { modelRegistry?: RegistryLike }).modelRegistry;
  const provider = PI_PROVIDER[backend];
  if (!registry) throw missing(backend, 'no model registry is available in this session.');
  let oauth = false;
  try {
    const model = registry.getAll?.().find(entry => entry.provider === provider);
    oauth = !!model && registry.isUsingOAuth?.(model as never) === true;
  } catch { /* an unreadable status is treated like no status; the resolved source is checked below */ }
  if (oauth) throw missing(backend, 'the stored login is OAuth, which cannot call this API. Log in with an API key instead.');
  let key: string | undefined, source: string | undefined;
  try {
    if (registry.getProviderAuth) { const result = await registry.getProviderAuth(provider); key = result?.auth?.apiKey; source = result?.source; }
    else key = await registry.getApiKeyForProvider?.(provider);
  } catch { /* reported below without any detail from the store */ }
  if (source && /oauth/i.test(source)) throw missing(backend, 'the stored login is OAuth, which cannot call this API. Log in with an API key instead.');
  if (!key || !key.trim()) throw missing(backend, 'no API key is stored.');
  return key.trim();
};

/** Presence only, for the settings panel: never returns or shows the key. */
export async function describeLogin(ctx: ExtensionContext, backend: Backend, resolve: KeyResolver = resolveApiKey): Promise<string> {
  if (backend === 'codex') return 'n/a';
  try { await resolve(ctx, backend); return 'API key found in Pi'; }
  catch (error) { return error instanceof ToolError ? error.message.replace(/^IMAGE_AUTH_MISSING: /, '') : 'could not check'; }
}
