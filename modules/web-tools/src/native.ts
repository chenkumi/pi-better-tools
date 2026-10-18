/** Chooses which provider-hosted search a request may use; config provider `openai` keeps its original OpenAI-only scope. */
import type { Config } from './config.ts';
import { injectNativeSearch as injectOpenAiSearch, NATIVE_GUIDANCE, supportsNativeSearch as supportsOpenAiSearch, type ModelIdentity } from './native-openai.ts';
import { GEMINI_GUIDANCE, injectGeminiSearch, isGeminiFamily, supportsGeminiNativeSearch } from './native-google.ts';
import { ANTHROPIC_GUIDANCE, injectAnthropicSearch, supportsAnthropicNativeSearch } from './native-anthropic.ts';

export type NativeAdapter = 'openai' | 'google' | 'anthropic';
export interface NativeModel extends ModelIdentity { id?: string }
export const NATIVE_GUIDANCE_BY_ADAPTER: Record<NativeAdapter, string> = { openai: NATIVE_GUIDANCE, google: GEMINI_GUIDANCE, anthropic: ANTHROPIC_GUIDANCE };
/** Every variant this module injects; prompts are stripped of all of them before re-adding one. */
export const NATIVE_GUIDANCES = [NATIVE_GUIDANCE, GEMINI_GUIDANCE, ANTHROPIC_GUIDANCE];
export const isNativeProvider = (provider: Config['provider']) => provider === 'openai' || provider === 'native';

export function selectNative(config: Config, model: NativeModel | undefined): NativeAdapter | undefined {
  if (!config.enabled || !isNativeProvider(config.provider)) return undefined;
  if (supportsOpenAiSearch(model)) return 'openai';
  if (config.provider !== 'native') return undefined;
  if (supportsGeminiNativeSearch(model)) return 'google';
  if (supportsAnthropicNativeSearch(model)) return 'anthropic';
  return undefined;
}

export function injectNative(adapter: NativeAdapter, payload: unknown): unknown {
  if (adapter === 'google') return injectGeminiSearch(payload);
  return adapter === 'anthropic' ? injectAnthropicSearch(payload) : injectOpenAiSearch(payload);
}

/** Why no adapter applies. Called only when `selectNative` returned undefined, so every branch is a real reason. */
export function nativeInactiveReason(config: Config, model: NativeModel | undefined): string {
  if (!isNativeProvider(config.provider)) return 'REST search selected';
  if (model?.api === 'pi-virtual') return 'virtual routing is unsupported: actual request provider metadata is unavailable; no injection or automatic fallback';
  if (config.provider === 'openai' && model && !supportsOpenAiSearch(model)) return 'provider is openai; set "provider": "native" to use the model\'s own search';
  if (model && isGeminiFamily(model)) return 'provider is not the pi google provider';
  if (model?.api === 'google-generative-ai') return 'Gemini 2.x does not support built-in search together with function declarations';
  if (model?.api === 'google-vertex') return 'Vertex AI does not support mixing search tools with function declarations';
  if (model?.api === 'anthropic-messages') return 'Anthropic-compatible endpoints are excluded; web search is enabled for the pi anthropic provider only';
  return 'model/API is unsupported';
}
