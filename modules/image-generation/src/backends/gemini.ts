import { ToolError } from '../../../../shared/src/tool-error/index.ts';
import type { Config } from '../config.ts';
import { postJson, providerError } from '../http.ts';
import { sniffImage } from '../images.ts';
import { clean } from '../text.ts';
import { MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES, numericUsage, type BackendEnv, type GeneratedImage, type GenerateRequest, type GenerateResult } from './types.ts';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const WIDE = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];
const NARROW = WIDE.filter(ratio => !['1:4', '4:1', '1:8', '8:1'].includes(ratio));
/** Models that predate the wide ratio set (and, for 2.5 Flash Image, the size parameter). Unknown models get the wide set and the API has the last word. */
const narrowRatios = (model: string) => /gemini-(?:3-pro|2\.5-flash)-image/.test(model);
const acceptsImageSize = (model: string) => !/gemini-2\.5-flash-image/.test(model);

export interface GeminiEnv extends BackendEnv { endpoint?: string }

/** One Interactions API call per image: the API has no image count. A later failure keeps the images already paid for. */
export async function generateGemini(request: GenerateRequest, config: Config['gemini'], apiKey: string, env: GeminiEnv): Promise<GenerateResult> {
  const ignored: string[] = [], notes: string[] = [];
  if (request.aspectRatio && !(narrowRatios(config.model) ? NARROW : WIDE).includes(request.aspectRatio)) {
    throw new ToolError('IMAGE_INVALID_ARGUMENT', `${config.model} does not support aspectRatio ${clean(request.aspectRatio, 20)}. Supported: ${(narrowRatios(config.model) ? NARROW : WIDE).join(', ')}.`);
  }
  if (request.format && request.format !== 'jpeg') ignored.push(`format ${request.format} (Gemini returns JPEG only)`);
  if (request.quality) ignored.push('quality (not a Gemini option)');
  if (request.transparentBackground) ignored.push('transparentBackground (Gemini cannot produce transparency)');
  const size = request.resolution ?? config.resolution;
  if (!acceptsImageSize(config.model) && request.resolution) ignored.push(`resolution (${config.model} has fixed output sizes)`);
  const responseFormat = { type: 'image', mime_type: 'image/jpeg', ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(acceptsImageSize(config.model) ? { image_size: size } : {}) };
  const images: GeneratedImage[] = [];
  const total: Record<string, number> = {};
  let requestId: string | undefined;
  for (let index = 0; index < request.count; index++) {
    env.onProgress?.(`Requesting image ${index + 1} of ${request.count} from Gemini (${config.model})…`);
    try {
      const result = await postJson({ url: env.endpoint ?? GEMINI_ENDPOINT, headers: { 'x-goog-api-key': apiKey }, body: { model: config.model, input: [{ type: 'text', text: request.prompt }], response_format: responseFormat }, timeoutMs: env.timeoutMs, maxBytes: MAX_RESPONSE_BYTES, ...(env.signal ? { signal: env.signal } : {}), ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}) });
      if (result.status < 200 || result.status >= 300) throw providerError('Gemini', result);
      requestId = result.requestId ?? requestId;
      images.push(...extractImages(result.json, result.requestId));
      const usage = numericUsage((result.json as { usage?: unknown }).usage, ['total_input_tokens', 'total_output_tokens', 'total_tokens']);
      for (const [key, value] of Object.entries(usage ?? {})) total[key] = (total[key] ?? 0) + value;
    } catch (error) {
      if (!images.length || (error instanceof ToolError && error.code === 'IMAGE_CANCELLED') || env.signal?.aborted) throw error;
      notes.push(`Stopped after ${images.length} of ${request.count} images: ${error instanceof ToolError ? error.message : 'the request failed'}`);
      break;
    }
  }
  if (images.length > request.count) images.length = request.count;
  return { images, model: config.model, controls: 'api', ignored, notes, ...(Object.keys(total).length ? { usage: total } : {}), ...(requestId ? { requestId } : {}) };
}

/** The image blocks of the `model_output` steps. Other steps (the thought signature alone is about 1 MB) are dropped unread. */
function extractImages(json: unknown, requestId?: string): GeneratedImage[] {
  const steps = json && typeof json === 'object' ? (json as { steps?: unknown }).steps : undefined;
  const found: GeneratedImage[] = [];
  const texts: string[] = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object' || (step as { type?: unknown }).type !== 'model_output') continue;
    const content = (step as { content?: unknown }).content;
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== 'object') continue;
      const { type, data, text } = block as { type?: unknown; data?: unknown; text?: unknown };
      if (type === 'text' && typeof text === 'string') texts.push(text);
      if (type !== 'image' || typeof data !== 'string' || !data) continue;
      const bytes = Buffer.from(data, 'base64');
      const info = bytes.length <= MAX_IMAGE_BYTES ? sniffImage(bytes) : undefined;
      if (!info) throw new ToolError('IMAGE_BAD_IMAGE', 'Gemini returned an image block that is not a valid png, jpeg or webp image.');
      found.push({ bytes, info });
    }
  }
  if (!found.length) throw new ToolError('IMAGE_NO_OUTPUT', `Gemini returned no image${texts.length ? `: ${clean(texts.join(' '), 300)}` : ''}${requestId ? ` [request ${requestId}]` : ''}.`);
  return found;
}
