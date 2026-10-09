import { isUtf8 } from 'node:buffer';
/** Fixed raw byte storage; never concatenate an unbounded line or decode before the cap. */
export class LineParser {
  private buffer = Buffer.alloc(16384); private length = 0; private failed = false;
  constructor(private emit: (text: string, partial: boolean) => void, private fail: (reason: string) => void) {}
  get bufferedBytes() { return this.length; }
  push(chunk: Buffer) {
    if (this.failed) return;
    for (const byte of chunk) {
      if (this.failed) return;
      if (byte === 10) { this.line(); continue; }
      if (this.length === this.buffer.length) { this.failed = true; this.fail('payload_limit'); return; }
      this.buffer[this.length++] = byte;
    }
  }
  private line() {
    let end = this.length; if (end && this.buffer[end - 1] === 13) end--;
    const bytes = this.buffer.subarray(0, end); this.length = 0;
    if (bytes.length) this.emit(bytes.toString('utf8'), !isUtf8(bytes));
  }
  end() { if (!this.failed && this.length) this.line(); }
}
/** Bound UTF8 after invalid-byte replacement without cutting a multi-byte sequence. */
export function preview(text: string, limit: number): string {
  // Callers supply bounded input (16KiB event or 8KiB raw stderr), not arbitrary logs.
  const bytes = Buffer.from(text); if (bytes.length <= limit) return text;
  let end = limit; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
