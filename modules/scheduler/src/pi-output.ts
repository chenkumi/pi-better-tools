import { StringDecoder } from "node:string_decoder";

export const MAX_CAPTURE_BYTES = 64 * 1024;
export const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;

/** Incremental classification remains complete even after retained output is full. */
export class PiOutputDiagnostics {
  private line = "";
  private dropping = false;
  private readonly errors: string[] = [];
  private assistantSeen = false;
  private finalAssistantError: string | undefined;
  actualModel?: { provider: string; model: string };
  ownershipUnknown = false;
  addError(error: string): void { if (this.errors.length < 20) this.errors.push(error.slice(0, 4096)); }
  feed(text: string): void {
    for (const part of text.split(/(?<=\n)/u)) {
      if (!this.dropping) {
        if (Buffer.byteLength(this.line) + Buffer.byteLength(part) > MAX_JSON_LINE_BYTES) {
          this.line = ""; this.dropping = true; this.addError("Pi JSON line exceeded the 2 MiB classification limit; outcome is unverified.");
        } else this.line += part;
      }
      if (part.endsWith("\n")) {
        if (!this.dropping) this.parse(this.line.trim());
        this.line = ""; this.dropping = false;
      }
    }
  }
  end(): void { if (this.line && !this.dropping) this.parse(this.line.trim()); this.line = ""; }
  result(requireAssistant = false): string[] {
    return [...this.errors, ...(this.finalAssistantError ? [this.finalAssistantError] : []),
      ...(requireAssistant && !this.assistantSeen ? ["Pi exited without a terminal assistant JSON response; outcome is unverified."] : [])];
  }
  private parse(line: string): void {
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as { error?: unknown; type?: unknown; message?: unknown };
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.error || parsed.type === "error") this.addError(typeof parsed.error === "string" ? parsed.error : String(parsed.message ?? "Pi reported an error"));
      if (parsed.type === "message_end" && parsed.message && typeof parsed.message === "object") {
        const message = parsed.message as { role?: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string };
        if (message.role === "assistant") {
          this.assistantSeen = true;
          const reason = typeof message.stopReason === "string" ? message.stopReason : "missing";
          const error = typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : `Pi assistant stopped: ${reason}`;
          this.finalAssistantError = reason === "stop" || reason === "length" ? undefined : error.slice(0, 4096);
          if (typeof message.provider === "string" && typeof message.model === "string") this.actualModel = { provider: message.provider, model: message.model };
        }
      }
    } catch { if (/\berror\b/i.test(line)) this.addError(line.trim()); }
  }
}

/** Never rejects before a caller attaches wait(); drain close/error as well as end. */
export function capturePiStream(stream: NodeJS.ReadableStream | null | undefined, diagnostics: PiOutputDiagnostics): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; const decoder = new StringDecoder("utf8");
    let bytes = 0, truncated = false, finished = false, ended = false;
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      diagnostics.feed(decoder.write(buffer));
      const take = Math.min(buffer.length, Math.max(0, MAX_CAPTURE_BYTES - bytes));
      // Copy a slice: retaining a view could retain a huge original backing Buffer.
      if (take) chunks.push(Buffer.from(buffer.subarray(0, take)));
      bytes += take; if (take < buffer.length) truncated = true;
    };
    const done = () => {
      if (finished) return; finished = true;
      diagnostics.feed(decoder.end()); diagnostics.end();
      stream.removeListener("data", data); stream.removeListener("end", end); stream.removeListener("close", close);
      resolve(new StringDecoder("utf8").write(Buffer.concat(chunks)) + (truncated ? "\n[truncated]" : ""));
    };
    const end = () => { ended = true; done(); };
    const close = () => { if (!ended) diagnostics.addError("Pi output pipe closed before end; outcome may be incomplete."); done(); };
    stream.on("data", data);
    stream.on("error", (error) => { diagnostics.addError(`Pi output pipe error: ${String(error)}`); done(); });
    stream.once("end", end); stream.once("close", close);
  });
}
