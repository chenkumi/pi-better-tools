import { createReadStream } from 'node:fs';

/** A single session line larger than this is reported, not read: the file is append-only JSON and no honest entry is this big. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface RawLine {
  line: number;
  /** Undefined when the line exceeds {@link MAX_LINE_BYTES}. */
  text?: string;
  bytes: number;
}

/**
 * Streams a file line by line without holding more than one line in memory. Lines are numbered the way an editor numbers
 * them: the first line is 1, and the final line counts even without a trailing newline. Stop early by breaking the loop.
 */
export async function* scanLines(path: string, first = 1, last = Number.POSITIVE_INFINITY): AsyncGenerator<RawLine> {
  const stream = createReadStream(path);
  let line = 1, parts: Buffer[] = [], bytes = 0, kept = 0;
  const flush = (): RawLine | undefined => {
    const out: RawLine | undefined = line >= first
      ? { line, bytes, ...(bytes <= MAX_LINE_BYTES ? { text: Buffer.concat(parts).toString('utf8').replace(/\r$/, '') } : {}) }
      : undefined;
    parts = []; bytes = 0; kept = 0; line++;
    return out;
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline;
        const piece = chunk.subarray(start, end);
        bytes += piece.length;
        if (line >= first && kept <= MAX_LINE_BYTES) { parts.push(piece); kept += piece.length; }
        if (newline === -1) break;
        const done = flush();
        if (done) yield done;
        if (line > last) return;
        start = newline + 1;
      }
    }
    if (bytes > 0 && line >= first && line <= last) { const tail = flush(); if (tail) yield tail; }
  } finally { stream.destroy(); }
}
