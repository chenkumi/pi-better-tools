import { createHash } from "node:crypto";
import { isPiVccCompactionDetailsV2 } from "../details.js";
export const SUMMARY_FORMAT_KEY = "blackhole.summaryFormat";
export type SummaryLayout = "structured-v1" | "literal-brief-v1";
export interface SummaryFormatProof { version: 1; layout: SummaryLayout | "literal-v1"; sourceGeneration: string }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const names = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];
/** This grammar validates a writer format; it never grants ownership by itself. */
function structuredPrefix(text: string): boolean {
  const prefix = text.split("\n\n---\n\n", 1)[0];
  let header = false; const seen = new Set<string>();
  for (const line of prefix.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\[([^\]]+)\]$/);
    if (match) { if (!names.includes(match[1]) || seen.has(match[1])) return false; seen.add(match[1]); header = true; continue; }
    if (!header || (!line.startsWith("- ") && !/^\s+\S/.test(line))) return false;
  }
  return header;
}
export function summaryFormatProof(text: string, layout: SummaryFormatProof["layout"]): SummaryFormatProof {
  return { version: 1, layout, sourceGeneration: digest(text) };
}
/** Latest canonical persisted writer + known details format + exact text generation.
 * Separate from mutable OM/recall spans: those cannot authorize structured merging.
 * Old Blackhole v1/v2 writers remain compatible only with their known prefix grammar.
 */
export function ownedSummaryLayout(text: string | undefined, entries: readonly any[] | undefined): SummaryLayout | undefined {
  if (text === undefined || !entries) return;
  const latest = [...entries].reverse().find(e => e.type === "compaction");
  if (!latest || latest.summary !== text || !structuredPrefix(text)) return;
  const d = latest.details;
  if (typeof d !== "object" || d === null || Array.isArray(d) || d.compactor !== "blackhole") return;
  const v1 = d.version === 1 && Array.isArray(d.sections) && d.sections.every((s: unknown) => typeof s === "string") && Number.isSafeInteger(d.sourceMessageCount) && d.sourceMessageCount >= 0 && typeof d.previousSummaryUsed === "boolean";
  if (!v1 && !isPiVccCompactionDetailsV2(d)) return;
  if (!(SUMMARY_FORMAT_KEY in d)) return "structured-v1";
  const p = d[SUMMARY_FORMAT_KEY];
  if (typeof p !== "object" || p === null || Array.isArray(p) || p.version !== 1 || !["structured-v1", "literal-brief-v1"].includes(p.layout) || p.sourceGeneration !== digest(text)) return;
  return p.layout;
}
