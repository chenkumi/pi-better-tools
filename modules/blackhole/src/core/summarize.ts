/**
 * Pi-vcc compile entry — orchestrates normalization → noise filtering → section building.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/summarize.ts)
 * Modified by pi-blackhole:
 * - threads touchMessages/cwd into buildSections for file-touch attribution
 *   (src/extract/file-touch.ts); merge logic otherwise unchanged.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatFileList } from "../extract/files";
import { formatSummaryComposition, type SummaryComposition, capBrief, capLiteralBrief, RECALL_NOTE, wrapLongLines } from "./format";
import { ownedSummaryLayout, summaryFormatProof, type SummaryLayout, type SummaryFormatProof } from "./summary-format.js";
import { generatedSpan, generatedSummaryProof, generatedSection, stripGeneratedSpans, type GeneratedSummaryProof } from "./generated-summary-spans.js";
import { stripNotificationEvidence } from "./notification-evidence.js";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  previousGeneratedSpans?: GeneratedSummaryProof;
  /** Canonical current branch, not a caller-supplied ownership boolean. */
  previousSummaryEntries?: readonly any[];
  onGeneratedSpans?: (proof: GeneratedSummaryProof) => void;
  onSummaryFormat?: (proof: SummaryFormatProof) => void;
  fileOps?: FileOps;
  /**
   * Raw (pre-convertToLlm) session messages for file-touch attribution.
   * Falls back to `messages` when omitted. bashExecution messages only exist
   * in the raw form, so passing these preserves bash mutation tracking.
   */
  touchMessages?: Message[];
  /** Working directory — merges relative/absolute file references. */
  cwd?: string;
  /** Git working-tree tags for fresh-window annotations (abs path → tag). */
  gitTags?: Map<string, string>;
  /**
   * Session-global `#N` index per message position (see
   * src/core/global-indices.ts). Parallel to `messages`; a missing entry
   * renders as no ref (fail-closed). Omitted entirely → legacy positional.
   */
  sourceIndices?: Array<number | undefined>;
}

const HEADER_NAMES = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences",
];

const SEPARATOR = "\n\n---\n\n";

/**
 * Join wrapped continuation lines back into their bullet item.
 *
 * formatSummary() wraps long lines at 120 chars with a space continuation
 * indent; both the fresh output and stored previous summaries reach the merge
 * below in that wrapped form. A wrapped "- Modified: a,\n  b,\n  c" bullet
 * spans several physical lines of which only the first starts with the
 * "- <Category>: " prefix — without rejoining, the merge silently keeps only
 * the entries on the first line and drops the rest.
 * Continuation lines start with spaces while bullets, headers and blank
 * separator lines never do, so joining "\n + non-space" with a single space
 * only ever rejoins wrapped content.
 */
const joinWrappedLines = (text: string): string => text.replace(/\n +(?=\S)/g, " ");

/** Extract a named section from summary text.
 *
 * The header must start at a line boundary — inline mentions such as
 * "`[Files And Changes]`" inside a hand-written pi-native summary must not
 * match, otherwise the "previous section" becomes a giant blob from the
 * mention to the end of the text and the merge drops almost everything.
 */
const sectionOf = (text: string, header: string): string => {
  // Escape the header name for regex safety
  const openEscaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = text.match(new RegExp(`(?:^|\\n)\\[${openEscaped}\\]`));
  if (!open || open.index === undefined) return "";
  const start = open.index + (open[0].startsWith("\n") ? 1 : 0);
  const after = joinWrappedLines(text.slice(start));
  // Find next section header (must start at line boundary to avoid matching in content)
  const nextSection = HEADER_NAMES.filter((h) => h !== header)
    .map((h) => {
      // Escape the header name for regex safety
      const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\n)\\[${escaped}\\]`);
      const m = after.match(re);
      if (!m) return -1;
      // m.index points to \n (or 0); advance past it to the [
      return m.index! + (m[0].startsWith("\n") ? 1 : 0);
    })
    .filter((n) => n >= 0);
  const nextSep = after.indexOf("\n\n---\n\n");
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};

/** Extract a header section WITHOUT rejoining continuation lines — preserves
 *  multi-line list format for Files And Changes merge. */
export const extractSection = (text: string, header: string): string => {
  const openEscaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = text.match(new RegExp(`(?:^|\\n)\\[${openEscaped}\\]`));
  if (!open || open.index === undefined) return "";
  // Start after the header line (skip "[Header]\n")
  // open.index points to the start of the match (either 0 or at a \n).
  // The header line ends at the first \n after the closing ].
  const headerStart = open.index + (open[0].startsWith("\n") ? 1 : 0); // position of [
  const headerEnd = text.indexOf("\n", headerStart); // \n after ]
  const start = headerEnd >= 0 ? headerEnd + 1 : text.length;
  const after = text.slice(start); // NO joinWrappedLines
  const nextSection = HEADER_NAMES.filter((h) => h !== header)
    .map((h) => {
      const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\n)\\[${escaped}\\]`);
      const m = after.match(re);
      if (!m) return -1;
      return m.index! + (m[0].startsWith("\n") ? 1 : 0);
    })
    .filter((n) => n >= 0);
  const nextSep = after.indexOf(SEPARATOR);
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};

/** Extract the brief transcript part (everything after ---) */
const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  // Outstanding Context is volatile -- always use fresh only
  if (header === "Outstanding Context") return fresh;
  // File callers pass the whole proven prefix; scope it before empty-side
  // handling, or a headerless fresh brief duplicates unrelated old sections.
  if (header === "Files And Changes") {
    return mergeFileLines(extractSection(prev, header), extractSection(fresh, header));
  }
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Session Goal, User Preferences: line-level dedup, cap
  const isClean = (l: string) =>
    l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  // Session Goal: keep first items so the original first message persists
  // Other sections: keep last items (fresh overrides stale)
  const capped =
    combined.length > CAP
      ? header === "Session Goal"
        ? combined.slice(0, CAP)
        : combined.slice(-CAP)
      : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/** Merge Files And Changes by category, dedup paths across compactions. */

/**
 * Git word-tag suffix appended by the fresh compile ("src/a.ts (staged)").
 * Tags from the previous summary are stripped (stale point-in-time state);
 * fresh-window tags survive.
 */
const GIT_TAG_SUFFIX_RE =
  /\s+\((?:staged|unstaged|new|renamed|deleted|conflicted|staged,unstaged)\)\s*$/;

/**
 * Add one header-rest or continuation line to the merged map, splitting on
 * top-level commas — a git word tag can contain one ("a.ts
 * (staged,unstaged)"); splitting inside the parens yields partial keys
 * ("a.ts (staged", "unstaged)") that defeat the prev/fresh dedup and
 * duplicate the file on re-touch. New-shape list lines hold a single
 * (comma-terminated) path, so the split is a no-op for them — including
 * after wrapLineWithContinuation fragments are reassembled by mergeFileLines.
 */
const addEntries = (
  merged: Record<string, Map<string, string>>,
  cat: string,
  isFresh: boolean,
  rest: string,
): void => {
  const text = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
  if (!text.trim()) return;
  const parts = text.split(/,(?![^()]*\))/);
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(GIT_TAG_SUFFIX_RE, "");
    const map = merged[cat];
    if (!map.has(key)) {
      // Fresh entries keep their tags; prev-only entries store the
      // stripped key — prev tags are stale point-in-time state.
      map.set(key, isFresh ? trimmed : key);
    }
  }
};

/** Last top-level comma ends the text (only whitespace after it). */
const endsWithTopLevelComma = (s: string): boolean => {
  let lastComma = -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) lastComma = i;
  }
  return lastComma >= 0 && s.slice(lastComma + 1).trim().length === 0;
};

/**
 * Append the next physical line to the pending fragment.
 *
 * A line that was hard-broken mid-token (overlong single-token path —
 * wrapTextWithAnsi splits without consuming a space) must be joined with NO
 * space, or the reconstructed path is corrupted. A space-broken continuation
 * (word wrap between entries/tags, e.g. a `(+N more)` tail) needs the space
 * back. A fragment without whitespace is a mid-token tail; a partial `(+N`
 * suffix is a space-broken token — joined with a space so the more-suffix
 * regex still matches.
 */
const appendFragment = (fragment: string, next: string): string => {
  if (fragment.length === 0) return next;
  if (/\s/.test(fragment) || /\(\+?\d*$/.test(fragment)) return `${fragment} ${next}`;
  return fragment + next;
};

export const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  // stripped path → display string; prev inserted first, fresh display wins
  const merged: Record<string, Map<string, string>> = {};
  for (const cat of categories) merged[cat] = new Map();

  // Preserved totals: a capped section's omitted entries are unparsable, so
  // the rendered count must never shrink below the largest total seen in any
  // header (`- Modified (26):`) or `(+N more)` tail across prev and fresh.
  const totals: Record<string, number> = {};
  const bumpTotal = (cat: string, n: number): void => {
    if (Number.isFinite(n) && n > (totals[cat] ?? 0)) totals[cat] = n;
  };

  // Parse both shapes:
  // - new: "- Modified (12):" header, one path per continuation line
  //   (entries carry trailing commas, so a hard-wrapped path's physical
  //   fragments reassemble into the single logical entry they came from)
  // - legacy: "- Modified: a, b (staged), c (+N more)" comma-joined
  // Fresh entries are recency-ordered (most recent first) and prev entries
  // follow in stored order, so the keep-first cap below retains the most
  // recent files instead of letting stale prev entries crowd out fresh
  // touches. Fresh display (with current git tags) wins ties by insertion
  // order — prev never overwrites an already-seen key.
  const headerRe = /^- (Modified|Created|Read)( \(\d+\))?:(.*)$/;
  const moreRe = /^\(\+\d+ more\)$/;
  for (const text of [fresh, prev]) {
    const isFresh = text === fresh;
    let current: string | null = null;
    let fragment = "";
    let listed = 0;
    const flush = (): void => {
      if (current === null || !fragment.trim()) {
        fragment = "";
        return;
      }
      const more = fragment.match(/\(\+(\d+) more\)\s*$/);
      const body = more ? fragment.slice(0, more.index) : fragment;
      const parts = body.split(/,(?![^()]*\))/).filter((p) => p.trim());
      listed += parts.length;
      if (more) bumpTotal(current, parts.length + Number(more[1]));
      addEntries(merged, current, isFresh, fragment);
      fragment = "";
    };
    for (const line of text.split("\n")) {
      const header = line.match(headerRe);
      if (header) {
        flush();
        current = header[1];
        if (header[2]) bumpTotal(current, Number.parseInt(header[2].replace(/\D/g, ""), 10));
        fragment = header[3];
        if (endsWithTopLevelComma(fragment)) flush();
        continue;
      }
      if (current === null) continue;
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        // Blank lines are wrap artifacts around a hard-broken fragment —
        // they never terminate the category; only real content lines do.
        if (line.trim()) {
          flush();
          current = null;
        }
        continue;
      }
      const entry = line.trim();
      if (!entry || moreRe.test(entry)) {
        const more = entry.match(/^\(\+(\d+) more\)$/);
        if (more && current !== null) bumpTotal(current, listed + Number(more[1]));
        continue;
      }
      fragment = appendFragment(fragment, entry);
      if (endsWithTopLevelComma(fragment)) flush();
    }
    flush();
  }

  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const key of merged.Modified.keys()) merged.Created.delete(key);
  // Also remove Read entries that also appear in Modified (same file read+edited)
  for (const key of merged.Modified.keys()) merged.Read.delete(key);

  const preservedTotal = (cat: string): number => Math.max(totals[cat] ?? 0, merged[cat].size);

  const lines: string[] = [];
  if (merged.Modified.size > 0)
    lines.push(
      `- ${formatFileList("Modified", [...merged.Modified.values()], 20, preservedTotal("Modified"))}`,
    );
  if (merged.Created.size > 0)
    lines.push(
      `- ${formatFileList("Created", [...merged.Created.values()], 20, preservedTotal("Created"))}`,
    );
  if (merged.Read.size > 0) {
    const arr = [...merged.Read.values()];
    const readTotal = preservedTotal("Read");
    lines.push(
      `- Read: ${arr.slice(0, 10).join(", ")}${readTotal > 10 ? ` (+${readTotal - 10} more)` : ""}`,
    );
  }
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

const mergePrevious = (prev: string, fresh: SummaryComposition, layout: SummaryLayout | undefined): SummaryComposition => {
  // Headers are data until the true latest persisted writer/format proves them.
  // Fresh authority comes from the writer's actual composition, never markers
  // in its brief or an assumption that the previous layout applies to it.
  if (!layout) {
    const literal = capLiteralBrief(prev);
    return { headers: fresh.headers, brief: [fresh.brief, literal].filter(Boolean).join(SEPARATOR), text: fresh.text ? fresh.text + SEPARATOR + literal : literal };
  }
  const prevHeaders = prev.split(SEPARATOR, 1)[0], freshHeaders = fresh.headers;
  // Merge only the proven structured prefix, never quoted headers in the body.
  const headers = HEADER_NAMES.map((header) => {
    // Files And Changes must NOT use sectionOf — it rejoins continuation lines
    // and destroys the multi-line list format needed for correct merge parsing.
    // Pass full summaries; mergeFileLines extracts the section itself.
    if (header === "Files And Changes") {
      return mergeHeaderSection(header, prevHeaders, freshHeaders);
    }
    const freshSec = sectionOf(freshHeaders, header);
    const prevSec = sectionOf(prevHeaders, header);
    return mergeHeaderSection(header, prevSec, freshSec);
  }).filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = fresh.brief;
  const mergedBrief = mergeBriefTranscript(prevBrief, freshBrief);

  const headerText = headers.join("\n\n");
  const brief = mergedBrief ? (layout === "literal-brief-v1" ? capLiteralBrief(mergedBrief) : capBrief(mergedBrief)) : "";
  return { headers: headerText, brief, text: [headerText, brief].filter(Boolean).join(SEPARATOR) };
};

const compileFresh = (
  input: Pick<
    CompileInput,
    "messages" | "fileOps" | "sourceIndices" | "touchMessages" | "cwd" | "gitTags"
  >,
): SummaryComposition => {
  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));
  const data = buildSections({
    blocks,
    messages: input.touchMessages ?? input.messages,
    fileOps: input.fileOps,
    cwd: input.cwd,
    gitTags: input.gitTags,
  });
  return formatSummaryComposition(data);
};

/** Build one fresh immutable VCC segment. It never reads an older summary. */
export const compileSegment = (
  input: Pick<
    CompileInput,
    "messages" | "fileOps" | "sourceIndices" | "touchMessages" | "cwd" | "gitTags"
  >,
): string => {
  const fresh = compileFresh(input);
  return fresh.text ? wrapLongLines(fresh.text) : "";
};

export const compile = (input: CompileInput): string => {
  const fresh = compileFresh(input);
  const prev = input.previousSummary ? (input.previousGeneratedSpans
    ? stripGeneratedSpans(input.previousSummary, input.previousGeneratedSpans)
    : stripNotificationEvidence(input.previousSummary, input.previousSummaryEntries ?? []) ?? input.previousSummary) : undefined;
  const previousLayout = ownedSummaryLayout(input.previousSummary, input.previousSummaryEntries);
  const merged = prev ? mergePrevious(prev, fresh, previousLayout) : fresh;
  if (!merged.text) return "";
  // Only this composition owns the new footer. Never strip freshly merged
  // transcript paragraphs based on marker text or OM-looking headers.
  const body = wrapLongLines(merged.text), footer = wrapLongLines(RECALL_NOTE);
  const summary = body + SEPARATOR + footer;
  input.onGeneratedSpans?.(generatedSummaryProof(summary, [generatedSpan(summary, "recall", body.length + SEPARATOR.length, footer.length)]));
  input.onSummaryFormat?.(summaryFormatProof(summary, !merged.headers ? "literal-v1" : prev && previousLayout !== "structured-v1" ? "literal-brief-v1" : "structured-v1"));
  return summary;
};

/** No proof means ordinary literal text, including identical user quotations. */
export const extractRecallNote = (text: string, proof?: GeneratedSummaryProof): string => generatedSection(text, proof, "recall");
export const stripRecallNotes = (text: string, proof?: GeneratedSummaryProof): string => stripGeneratedSpans(text, proof, ["recall"]);
export const stripOMContent = (text: string, proof?: GeneratedSummaryProof): string => stripGeneratedSpans(text, proof, ["om"]);
