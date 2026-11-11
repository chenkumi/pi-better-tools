import type { RESOLUTIONS } from '../config.ts';
import type { ImageInfo } from '../images.ts';

export type Resolution = (typeof RESOLUTIONS)[number];
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** The unified request. Each backend maps what it can and reports the rest in `ignored`. */
export interface GenerateRequest {
  prompt: string;
  aspectRatio?: string;
  resolution?: Resolution;
  quality?: string;
  format?: ImageFormat;
  transparentBackground?: boolean;
  count: number;
}
export interface GeneratedImage { bytes: Buffer; info: ImageInfo }
export interface GenerateResult {
  images: GeneratedImage[];
  model: string;
  /** `api`: the provider received the options as parameters. `prompt-hint`: they were only written into the prompt (not guaranteed). */
  controls: 'api' | 'prompt-hint';
  /** Request options this backend cannot apply. */
  ignored: string[];
  /** Other things worth telling the caller (adjusted size, fewer images than asked, a failed later call). */
  notes: string[];
  usage?: Record<string, number>;
  requestId?: string;
}
export interface BackendEnv {
  signal?: AbortSignal;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  onProgress?: (text: string) => void;
}
/** One response body is capped here; a Gemini answer alone carries about 1 MB of thought signature next to the image. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** One image file read back from disk (Codex) or decoded from a response. */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024;

export function parseRatio(value: string): { w: number; h: number } | undefined {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value);
  if (!match) return undefined;
  const w = Number(match[1]), h = Number(match[2]);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

export function numericUsage(value: unknown, fields: readonly string[]): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const field of fields) { const v = (value as Record<string, unknown>)[field]; if (typeof v === 'number' && Number.isFinite(v)) out[field] = v; }
  return Object.keys(out).length ? out : undefined;
}
