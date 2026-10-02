import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { capturePiStream, MAX_CAPTURE_BYTES, MAX_JSON_LINE_BYTES, PiOutputDiagnostics } from "../../src/pi-output.js";
import { truncateOutput } from "../../src/run-store.js";
const terminal = (reason = "stop") => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: reason, errorMessage: reason === "error" ? "final failure" : undefined } });
describe("bounded Pi output", () => {
  it("fails closed on malformed terminal field types instead of swallowing a parser TypeError", () => {
    const diagnostics = new PiOutputDiagnostics();
    diagnostics.feed(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: false, errorMessage: true } })); diagnostics.end();
    expect(diagnostics.result(true)).toEqual(["Pi assistant stopped: missing"]);
  });
  it("classifies split JSON and UTF-8 without retaining partial-byte corruption", async () => {
    const stream = new PassThrough(), diagnostics = new PiOutputDiagnostics(); const output = capturePiStream(stream, diagnostics);
    const bytes = Buffer.from(terminal() + "\n你好\n"); for (const byte of bytes) stream.write(Buffer.from([byte])); stream.end();
    expect(await output).toContain("你好"); expect(diagnostics.result(true)).toEqual([]);
    expect(truncateOutput("你好你好", 4)).toBe("你\n[truncated]");
  });
  it("detects and recovers framing after an oversized JSON line, failing closed", () => {
    const diagnostics = new PiOutputDiagnostics(); diagnostics.feed("x".repeat(MAX_JSON_LINE_BYTES + 1)); diagnostics.feed("\n" + terminal("error")); diagnostics.end();
    expect(diagnostics.result()).toEqual([expect.stringMatching(/exceeded/), "final failure"]);
  });
  it("bounds output while preserving terminal classification after the capture cap", async () => {
    const stream = new PassThrough(), diagnostics = new PiOutputDiagnostics(); const output = capturePiStream(stream, diagnostics);
    stream.write("x".repeat(MAX_CAPTURE_BYTES) + "\n"); stream.end(terminal("error"));
    expect(Buffer.byteLength(await output)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES + 12); expect(diagnostics.result()).toContain("final failure");
  });
  it("handles a pipe error before its caller awaits the output promise", async () => {
    const stream = new PassThrough(), diagnostics = new PiOutputDiagnostics(); const output = capturePiStream(stream, diagnostics);
    stream.write("partial"); stream.destroy(new Error("injected EPIPE")); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await output).toBe("partial"); expect(diagnostics.result().join(" ")).toMatch(/EPIPE/);
  });
  it("resolves an early close rather than waiting forever for end", async () => {
    const stream = new PassThrough(), diagnostics = new PiOutputDiagnostics(); const output = capturePiStream(stream, diagnostics);
    stream.destroy(); expect(await output).toBe(""); expect(diagnostics.result().join(" ")).toMatch(/closed before end/);
  });
});
