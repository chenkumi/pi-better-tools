import { ToolError } from '../../../../shared/src/tool-error/index.ts';
import type { Config } from '../config.ts';
import { postJson, providerError } from '../http.ts';
import { sniffImage } from '../images.ts';
import { clean } from '../text.ts';
import { MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES, numericUsage, parseRatio, type BackendEnv, type GenerateRequest, type GenerateResult, type Resolution } from './types.ts';

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/images/generations';

const LONG_EDGE: Record<Resolution, number> = { '1K': 1024, '2K': 2048, '4K': 3840 };
const MIN_PIXELS = 655_360, MAX_PIXELS = 8_294_400, MAX_EDGE = 3840;
const FIXED_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

/** gpt-image-2 and later accept WIDTHxHEIGHT (both a multiple of 16, ratio 1:3 to 3:1); earlier models only the fixed sizes. */
export const acceptsCustomSize = (model: string): boolean => /^gpt-image-(?:[2-9]|\d{2,})/.test(model);

/**
 * The `size` parameter for an aspect ratio and a resolution tier. `auto` when neither is given. For a model without custom
 * sizes the nearest fixed size by orientation is used and `note` says so.
 */
export function openaiSize(model: string, aspectRatio?: string, resolution?: Resolution): { size: string; note?: string } {
  if (!aspectRatio && !resolution) return { size: 'auto' };
  const ratio = aspectRatio ? parseRatio(aspectRatio) : { w: 1, h: 1 };
  if (!ratio) throw new ToolError('IMAGE_INVALID_ARGUMENT', `aspectRatio "${clean(aspectRatio, 20)}" must look like 16:9.`);
  if (ratio.w / ratio.h > 3 || ratio.h / ratio.w > 3) throw new ToolError('IMAGE_INVALID_ARGUMENT', 'OpenAI accepts aspect ratios between 1:3 and 3:1.');
  if (!acceptsCustomSize(model)) {
    const size = ratio.w === ratio.h ? FIXED_SIZES[0]! : ratio.w > ratio.h ? FIXED_SIZES[1]! : FIXED_SIZES[2]!;
    return { size, note: `${model} only supports fixed sizes; ${size} was used (nearest by orientation)${resolution ? ', resolution was not applied' : ''}.` };
  }
  const round = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  const dims = (long: number) => ({
    w: ratio.w >= ratio.h ? long : round(long * ratio.w / ratio.h),
    h: ratio.w >= ratio.h ? round(long * ratio.h / ratio.w) : long,
  });
  const requested = LONG_EDGE[resolution ?? '1K'];
  let long = requested;
  // A square or near-square 4K is over the pixel cap: shrink the long edge until it fits. A thin ratio at 1K is under the minimum: grow it.
  while (long > 16 && dims(long).w * dims(long).h > MAX_PIXELS) long -= 16;
  while (long < MAX_EDGE && dims(long).w * dims(long).h < MIN_PIXELS) long += 16;
  const { w, h } = dims(long);
  if (w * h < MIN_PIXELS || w * h > MAX_PIXELS || Math.max(w, h) > MAX_EDGE) throw new ToolError('IMAGE_INVALID_ARGUMENT', `No valid OpenAI size for ${aspectRatio ?? '1:1'} at ${resolution ?? '1K'}.`);
  return { size: `${w}x${h}`, ...(long < requested ? { note: `${resolution ?? '1K'} is above OpenAI's pixel limit for ${aspectRatio ?? '1:1'}; ${w}x${h} was used.` } : {}) };
}

export interface OpenAIEnv extends BackendEnv { endpoint?: string }

export async function generateOpenAI(request: GenerateRequest, config: Config['openai'], apiKey: string, env: OpenAIEnv): Promise<GenerateResult> {
  const ignored: string[] = [], notes: string[] = [];
  const { size, note } = openaiSize(config.model, request.aspectRatio, request.resolution);
  if (note) notes.push(note);
  let format = request.format ?? config.format;
  if (request.transparentBackground) {
    if (request.format === 'jpeg') throw new ToolError('IMAGE_INVALID_ARGUMENT', 'A transparent background needs png or webp, not jpeg.');
    if (format === 'jpeg') { format = 'png'; notes.push('The configured format jpeg cannot be transparent; png was used.'); }
  }
  const body = {
    model: config.model, prompt: request.prompt, n: request.count, size, quality: request.quality ?? config.quality, output_format: format,
    ...(request.transparentBackground ? { background: 'transparent' } : {}),
  };
  env.onProgress?.(`Requesting ${request.count} image(s) from OpenAI (${config.model})…`);
  const result = await postJson({ url: env.endpoint ?? OPENAI_ENDPOINT, headers: { authorization: `Bearer ${apiKey}` }, body, timeoutMs: env.timeoutMs, maxBytes: MAX_RESPONSE_BYTES, ...(env.signal ? { signal: env.signal } : {}), ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}) });
  if (result.status < 200 || result.status >= 300) throw providerError('OpenAI', result);
  const data = result.json && typeof result.json === 'object' ? (result.json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || !data.length) throw new ToolError('IMAGE_NO_OUTPUT', `OpenAI returned no image${result.requestId ? ` [request ${result.requestId}]` : ''}.`);
  const images = data.map((entry, index) => {
    const b64 = entry && typeof entry === 'object' ? (entry as { b64_json?: unknown }).b64_json : undefined;
    if (typeof b64 !== 'string' || !b64) throw new ToolError('IMAGE_NO_OUTPUT', `OpenAI image ${index + 1} has no image data (only base64 output is supported).`);
    const bytes = Buffer.from(b64, 'base64');
    const info = bytes.length <= MAX_IMAGE_BYTES ? sniffImage(bytes) : undefined;
    if (!info) throw new ToolError('IMAGE_BAD_IMAGE', `OpenAI image ${index + 1} is not a valid png, jpeg or webp image.`);
    return { bytes, info };
  });
  if (images.length < request.count) notes.push(`OpenAI returned ${images.length} of ${request.count} requested images.`);
  const usage = numericUsage((result.json as { usage?: unknown }).usage, ['input_tokens', 'output_tokens', 'total_tokens']);
  return { images, model: config.model, controls: 'api', ignored, notes, ...(usage ? { usage } : {}), ...(result.requestId ? { requestId: result.requestId } : {}) };
}
