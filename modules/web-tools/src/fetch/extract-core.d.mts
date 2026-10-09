export const MAX_HTML_BYTES: number;
export const MAX_EXTRACTED_BYTES: number;
export type ExtractionMode = 'auto' | 'main' | 'body';
export type ContentFormat = 'markdown' | 'text';
export type ExtractionResult = { title: string; content: string; extraction: string; warnings: string[] };
export function extractHtml(html: string, url: string, format?: ContentFormat, mode?: ExtractionMode): ExtractionResult;
