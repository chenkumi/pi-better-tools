import { createHash } from "node:crypto";
export type GeneratedKind = "recall" | "om" | "evidence";
export interface GeneratedSpan { kind: GeneratedKind; offset: number; length: number; sha256: string }
export interface GeneratedSummaryProof { version: 1; sourceGeneration: string; spans: GeneratedSpan[] }
export const GENERATED_SPANS_KEY = "blackhole.generatedSpans";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Call only at the actual composition site, never infer ownership from a marker. */
export function generatedSpan(text: string, kind: GeneratedKind, offset: number, length: number): GeneratedSpan {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > text.length) throw new Error("Invalid generated span");
  return { kind, offset, length, sha256: digest(text.slice(offset, offset + length)) };
}
export function generatedSummaryProof(text: string, spans: GeneratedSpan[]): GeneratedSummaryProof {
  return { version: 1, sourceGeneration: digest(text), spans };
}
/** Offsets originate from actual ordered composition, not searches for headers. */
export function composeGeneratedParts(parts: Array<{ text: string; kind?: GeneratedKind; proof?: GeneratedSummaryProof }>): { text: string; proof: GeneratedSummaryProof } {
  let text = "";
  const spans: GeneratedSpan[] = [];
  for (const part of parts.filter(p => p.text.length > 0)) {
    if (text) text += "\n\n";
    const offset = text.length;
    text += part.text;
    if (part.kind) spans.push(generatedSpan(text, part.kind, offset, part.text.length));
    else if (validGeneratedProof(part.text, part.proof)) for (const span of part.proof!.spans) spans.push({ ...span, offset: span.offset + offset });
  }
  return { text, proof: generatedSummaryProof(text, spans) };
}
export function validGeneratedProof(text: string, proof: any): proof is GeneratedSummaryProof {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof) || proof.version !== 1 || typeof proof.sourceGeneration !== "string" || !/^[a-f0-9]{64}$/.test(proof.sourceGeneration) || proof.sourceGeneration !== digest(text) || !Array.isArray(proof.spans) || proof.spans.length > 8) return false;
  // Persisted JSON is untrusted. Validate every element before dereferencing in sort.
  for (const span of proof.spans) {
    if (typeof span !== "object" || span === null || Array.isArray(span) || !["recall", "om", "evidence"].includes(span.kind) || !Number.isSafeInteger(span.offset) || !Number.isSafeInteger(span.length) || span.offset < 0 || span.length < 1 || !Number.isSafeInteger(span.offset + span.length) || span.offset + span.length > text.length || typeof span.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(span.sha256) || digest(text.slice(span.offset, span.offset + span.length)) !== span.sha256) return false;
  }
  let end = 0;
  for (const span of [...proof.spans].sort((a, b) => a.offset - b.offset)) {
    if (span.offset < end) return false;
    end = span.offset + span.length;
  }
  return true;
}
/** Persisted ownership requires the canonical latest Blackhole writer and exact source generation. */
export function ownedSummaryProof(text: string | undefined, entries: readonly any[]): GeneratedSummaryProof | undefined {
  if (text === undefined) return;
  const latest = [...entries].reverse().find(e => e.type === "compaction");
  if (latest?.details?.compactor !== "blackhole") return;
  const metadata = latest.details[GENERATED_SPANS_KEY];
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || metadata.version !== 1) return;
  const proof = text === latest.summary ? metadata?.summary : text === latest.details.trailingSummary ? metadata?.trailing : undefined;
  return validGeneratedProof(text, proof) ? proof : undefined;
}
export function stripGeneratedSpans(text: string, proof?: GeneratedSummaryProof, kinds: readonly GeneratedKind[] = ["recall", "om", "evidence"]): string {
  if (!validGeneratedProof(text, proof)) return text;
  let result = text;
  for (const span of [...proof!.spans].filter(s => kinds.includes(s.kind)).sort((a, b) => b.offset - a.offset)) result = result.slice(0, span.offset) + result.slice(span.offset + span.length);
  return result;
}
export function generatedSection(text: string, proof: GeneratedSummaryProof | undefined, kind: GeneratedKind): string {
  if (!validGeneratedProof(text, proof)) return "";
  const span = proof!.spans.find(s => s.kind === kind);
  return span ? text.slice(span.offset, span.offset + span.length) : "";
}
