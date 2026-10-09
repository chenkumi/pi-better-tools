# Recall System

The recall system provides searchable session history after compaction. Pi's default compaction discards old messages; blackhole preserves them through a unified `recall` tool and `/blackhole-recall` command.

## recall tool

The agent gets a unified `recall` tool registered via [[src/tools/recall.ts]]. It handles transcript, file, memory and additive notification-evidence queries:

### Entry expansion (#N)

Expands a session entry by index to show full content (not truncated). Parsed by `VCC_ENTRY_PATTERN` (`/^#(\d+)$/`).

Calls `vccRecall({ query: "", expand: [index] })`, merges expanded entries into results (appends non-overlapping, replaces overlapping). Invalid indices outside available range are reported via `invalidExpandIndices()`.

### Drill-down (#N:path / #N:text)

Explores file content from a tool call within a specific entry, or a message body. Parsed by [[src/core/drill-down.ts]].

Pattern: `#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$`

| Syntax | Behavior |
|--------|----------|
| `#42:auth.ts` | File preview, first 30 lines |
| `#42:auth.ts:full` | All file content (50KB cap) |
| `#42:auth.ts:30` | Lines 31-60 (offset 30, default limit 30) |
| `#42:auth.ts:30:20` | Lines 31-50 (offset 30, limit 20) |
| `#42:file` | List all files, or auto-select if single |
| `#42:text` | Message-body preview (first 30 lines) |
| `#42:text:full` | Full message body (50KB cap) |
| `#42:text:30` / `#42:text:30:20` | Message-body windows |

Reads raw session JSONL via `loadAllMessages()`, finds content-bearing tool calls via `isContentBearing()`, matches path via `tc.path.includes(pathPattern)`. Formats edits as `--- edit N ---\noldText\n--- becomes ---\nnewText`. The `#N:text` form covers user/assistant/toolResult text plus bashExecution command+output, so budget-clipped expanded entries can be paged in full.

### Result-correlated Note/File activity (B1 local integration)

Native `note` accepts only `{type,content}`. The consumer requires one chronological matching toolCallId/name pair with explicit host `isError:false`, then takes `details.relativePath` from the successful result. It validates the expected type folder and a confined two-component relative path; no filename is guessed or added to the original arguments. Duplicate IDs, missing/mismatched results, unsafe note paths and error/cancelled calls cannot claim creation. Correlation preserves existing raw messages and numeric `#N` references.

Successful notes appear as Created in compaction file lists, in file/content search and `mode:touched`, and in `#N:file` / `#N:<returned-path>` drill-down. Content comes from stored `content`, not the live document. Search/extraction uses the existing 10,240-character per-call prefix; a later substring need not be indexed, but remains available through explicit line paging. Full note display uses a UTF8-safe 50 KiB prefix independently of the default 48,000-character response cap. The smaller response cap can omit the later 50KiB footer; line paging remains available. No budget is increased or new schema/config introduced.

Known file activity requires acknowledged results, not call arguments alone or call-derived native fileOps seeds. Raw collection selects this authority from originating File-call IDs, not just the result's tool name; it retains the rejection boundary when duplicate IDs are absent from valid pairs. File arguments never enter speculative legacy actions. Unique same-name call-before-result pairing, explicit false and the exact raw result position are required before any permitted legacy pathless-result recovery. Non-File mismatches and missing flags cannot fall back to File actions; unrelated non-File legacy parsing remains unchanged. Read uses the returned actual/corrected path; write uses `created:true` for creation; edit uses nonnegative integer `changedCount` rather than noop-looking quoted diff text (legacy text fallback remains when that metadata is unavailable). Modern 32-hex version-token metadata marks literal filenames so editor-looking suffixes are not stripped; this marker is not filesystem identity proof. General transcript/file-argument search may still expose unsuccessful proposals as historical text, not successful activity.

A successful exact-input-path retry removes only the corresponding outstanding file error; Note retries require the same type/content payload and a valid acknowledgement. Historical error text and its raw `#N` source remain. For host-declared File Tools errors only, a well-formed `[FILE_TOOL_ERROR]` JSON body up to 16,384 characters can supply scalar code/message for the existing bounded display; body status never decides outcome. Malformed/oversized bodies fall back to their first line and remain raw-recallable. An unpaired/pathless same-tool result is not proof that a previous file error resolved.

Windows 8.3 identity is **separately blocked**, not silently fixed: the standalone `tests/fixtures/note-file-alias-probe.mjs` reproduced the real short-cwd/long-Git-root mismatch through Git → extractFiles → compile with unchanged fixture hashes. No new filesystem metadata probes, symlink following, outside-cwd reads, basename matching, whole-path lowercasing or guessed alias expansion are added. A future bounded, verified directory-identity capability requires an explicit decision. This does not change A's notification retention, compaction timing or evidence schema.

### Allowlisted notification evidence (`e:<entry-id>`, local integration)

Pi 1.1.0 persists `sendMessage`/boundary diagnostics as `type:"custom_message"` with top-level `customType`, `content`, `details`, `id`, `parentId` and `timestamp`. Context projection produces `role:"custom"`; provider conversion uses user content. Plain `type:"custom"` entries instead store state/display data and are not notification evidence. The shared projection in `src/core/notification-evidence.ts` keeps these distinctions explicit.

The allowlist is intentionally narrow:

| Persisted customType | Selected evidence |
|---|---|
| `shell-job-completed` | Batched terminal jobs; details own status/exitCode, matching content supplies only public output/error excerpts |
| `subagent_background` | `task_result` and `query_result` only; task/query/job IDs, terminal result, cleanupPending, root query lateUsage/snapshotUnavailable booleans and structured asOf snapshot |
| `pi-runtime-recovery` | Bounded attempt/limit, task/error entry IDs, mode and diagnostic class; never a success acknowledgement |
| `scheduled_prompt` | `subagent_done` (including skipped) and `subagent_error`; no start/inline prompt marker |
| `background-runtime-recovery-shell` / `background-runtime-recovery-subagent` | Reconciliation findings, validated task state and recorded outcome, last known state, unknown process-tree state, incomplete/omitted diagnostics |

Search by job/task/query ID in hybrid mode, then use `recall({query:"e:<persisted-entry-id>"})`; use `page` for the next partial projection page. Active lineage is the default; `scope:"all"` opts into other branches. `/blackhole-recall e:<entry-id> page:2 scope:all` uses the same bounded evidence expansion (48,000-character default); unlike legacy command text, this new evidence path is bounded. File/touched modes do not index notifications.

`e:` is a separate stable namespace using the existing persisted entry ID, **not a number assigned among custom entries**. The `query` schema remains a string; `expand` stays numeric for legacy messages. `global-indices.ts`, `loadAllMessages()` and all old `#N` numbering are unchanged. No evidence side index is persisted, no old JSONL is rewritten, and reload does not replay jobs or create notifications.

Summary keeps at most 16 recent refs within an 8,000-character structural-data budget (1,600 characters per entry). Structural data comes **only from validated producer-specific details**, never the body/display merge. Body output/error can supply scalar display text only; object-valued text is not a container. Recovery outcome must agree with terminal finding/lastKnownState/all task states; processTreeState remains unknown, not a cleanup acknowledgement.

New compactions optionally add `details["blackhole.notificationEvidence"] = {version:1,summary:{offset,length,sha256,refs},trailing?:{offset,length,sha256,refs}}`. This narrow optional metadata preserves existing compaction versions 1/2 and their validators, tool schemas, config and numeric refs. The actual generated section span/digest/refs are captured using insertion offsets from fallback and (for append mode) trailing composition, never first/last matching Markdown. Identical quotations elsewhere cannot move the generated span. Carry-forward and stripping require the latest Blackhole compaction on the selected canonical branch, the exact matching stored summary/trailingSummary, bounded span, SHA-256 and ref-list agreement. Markdown headers alone cannot authorize carry-forward or stripping: legacy quotations remain untouched and **old summaries without verified metadata are not backfilled**, even if they contain the old evidence header. There is no migration/rewrite of old compactions. This is provenance within the existing trusted persisted-entry channel, not a signature against a writer able to forge compaction details. Only verified spans are removed before generic heuristics; refs are reprojected against effective branch entries using Pi's compaction-aware eligible edits. Null/replaced notifications retain state-only coordinate skeletons without old producer details. A native invisible-backtrack cut may legally point to such a skeleton; unknown/duplicate nonempty cut IDs return bounded incomplete diagnostics, never include-all evidence or fabricated coverage. Results remain untrusted data, never system/developer authority to resume work. Completed status never implies cleanup is confirmed.

Evidence file inspection uses its own `notification-evidence-scan.ts` (the legacy scanner is unchanged): at most 32 MiB bytes read, 100,000 JSONL lines parsed/processed, and a fixed 64 KiB line buffer plus a 64 KiB read chunk. Oversized lines are skipped **before JSON.parse**, with a line-limit warning; scanning can continue to a valid tail within the overall limits. Entry/byte/payload exhaustion stops the evidence scan early; `scanStats` makes the bound testable. Malformed JSON, malformed allowlisted notifications, projection faults and each budget limit have distinct `incomplete` reasons, not a blanket budget-exceeded message. In-memory branch summary collection already receives parsed host entries, so its 64 KiB record/4 MiB relevant-payload checks are projection limits, **not host parse/I/O protection**. Legacy message search may still invoke the unchanged raw scanner; evidence scan limits do not bound that separate path.

Projection also limits nested lists to 32 records, nesting to five levels, and selected text to 8,192 characters. Snapshot pending/toolCall IDs are opaque host strings (including `call_A|fc_B`), scrubbed and capped at 200 characters independently of persisted entry refs; truncation, cleaning or filtering explicitly marks `partial`. Nullable snapshot entry/sourceLeaf IDs and sourceTurn ordinals are retained. The producer's pendingToolCallIdsTruncated flag is preserved as producer metadata, while `partial` describes additional projection loss. Oversized records and known ambiguous duplicate IDs fail closed; incomplete inspection does not establish global uniqueness or any absent outcome. Only producer-specific fields are returned: prompts, command text, controls, private temporary/query storage and credential objects are excluded. Common credential assignments, bearer/API keys, URL userinfo and terminal/bidi controls are scrubbed in public output. This is defense in depth, **not a guarantee that arbitrary unlabeled secrets can be recognized**.

The projected payload may be partial even when the original producer's `outputTruncated` is false; that flag describes the producer's output capture, not this projection's completeness. Paging recovers the bounded selected data, not omitted private fields or clipped original text. Original content stays in raw session history, but is not automatically reintroduced to provider context or reconstructed from transient logs. No log/artifact is read, no cleanup is performed, and no provider is called by evidence retrieval.

Evidence ID pages reserve a stable worst-case header/footer envelope before allocating body. Returned `[Evidence body]` windows are exact and never sliced after cursor calculation; continuation is advertised only for delivered body. If the budget cannot fit the envelope plus one character, `isError` and `details.notificationEvidence.reason:"budget_insufficient"` report zero delivered chars and no next page, with the required minimum budget. Tiny caps under 19 characters use `!` plus structured diagnostic details (a one-character cap cannot carry a readable sentence); raise `recallResponseMaxChars` to read the diagnostic/data. `0` remains unbounded for the selected payload. Command ID queries use this same implementation at the documented default budget; they do not pick up the live tool's configured cap.

Query diagnostic booleans (`lateUsage`, `snapshotUnavailable`) are selected from details for both root query_result and nested task queries, including false values; body claims cannot supply or overwrite them. Late usage never revives a failed/aborted query status.

An unavailable `e:` ref also obeys the text cap: full selected-scope explanation if it fits (or cap=0), otherwise `No matches; outcome unknown.` if it fits, else `!`. The structured diagnostic is `details.notificationEvidence.reason:"unavailable_in_selected_inspection"`, with possibilities missing/excluded/ambiguous/uninspected, scope, inspectionIncomplete/reasons, outcomeKnown:false and deliveredChars:0. It has no body, offset or next page, and does not assert absence in all raw history. Diagnostic details remain available even when the text cap cannot carry the full scanner warning; no private raw payload is added.

### Response budget

Every recall response is capped at `recallResponseMaxChars` (default 48,000 characters ≈ 12k tokens, `0` = unbounded). Implemented in [[src/core/recall-budget.ts]] and threaded through [[src/tools/recall.ts]]:

- **Search snippet lines** are capped (~1000 chars) with the match kept visible, so one huge tool-result line cannot flood a page.
- **Expanded entries** share the budget (`expandAllocation()`); each carries a continuation marker to `#N:text:full` / `#N:path:full` for the full payload.
- **Drill-down bodies** (`#N:path`, `#N:text`) are capped to the same total budget by `capDrillDownText()`. The cut only ever lands on a line boundary, and the footer names the first line it did not show (`continue at #42:src/auth.ts:412:30`), so following the hint neither skips nor re-reads content. Degenerate cases say so plainly instead of inventing a resume point: a line too big for the budget is named and paged past (`the line at offset 42 does not fit the budget; continue at ...`), nothing left to page points at a regex query, and a header so large that no line fits asks for a single line.
- **Related observation/reflection bodies** are capped (~1200 chars); full content stays reachable via the 12-hex memory id.
- **Total budget** (`capRecallBlocks()`) is enforced entry-aware: trailing entries drop before the header, and a footer names the omitted count and continuation affordance (`page:N` / `expand:[N]` / `#N:text` / `#N:path`).

The knob is `recallResponseMaxChars` (env `PI_BLACKHOLE_RECALL_RESPONSE_MAX_CHARS`); per-entry and per-line shares are derived from it internally.

### OM memory ID (12-char hex)

Recovers source evidence for a specific observation or reflection from the session ledger. Parsed by `MEMORY_ID_PATTERN` (`/^[a-f0-9]{12}$/`).

Calls `omRecall(id)` → `recallMemorySources()` from [[src/om/ledger/recall.ts]]. Shows observations (with `[dropped]` marker for tombstoned ones), reflections, and source entries. Annotates sources with `#N` indices via `buildIndexMap()` + `formatEntryIndexAnnotation()`.

### Free text search (BM25)

BM25-ranked OR search across transcript text and/or file content. Rare terms weighted higher. Defined in [[src/core/search-entries.ts]].

#### BM25 algorithm

Constants: `BM25_K = 1.2`, `BM25_B = 0.75`. ~70 English stopwords filtered from queries.

```
IDF = log((N - df + 0.5) / (df + 0.5) + 1)
TF-Norm = (tf * (K + 1)) / (tf + K * (1 - B + B * dl / avgDl))
Score = sum(IDF * TF-Norm for each term)
```

Stopwords removed from query terms before scoring. Each term is classified individually: terms with regex operators (`/[|*+?{}()[\]\\^$]/`) stay patterns, plain terms — including dotted filenames (`observer.ts`) — match literally. A natural sentence mentioning a file therefore ranks via BM25 instead of compiling as one never-matching whole-query pattern.

#### Search modes

| Mode | Searches |
|------|----------|
| `hybrid` (default) | Transcript text + tool call args + allowlisted notification data |
| `file` | Only tool call args (file content) |
| `touched` | Aggregate all files written/edited, grouped by path |

#### File indicators

`getFileIndicators()` counts lines per file in content-bearing tool calls. `computeFileMatches()` filters lines matching query regex with snippets (`±2` context lines). `getTouchedFiles()` aggregates entries per path for `mode:touched`.

### Scope

`scope:lineage` (default) searches only the active lineage. `scope:all` searches across all session lineages. Active lineage extracted via [[src/core/lineage.ts]] `getActiveLineageEntryIds()`.

### Pagination

`page:N` (1-based, default 5 results per page). Expand entries merged before pagination for consistent counts. Footer includes scope hint.

## Generated summaries and edited OM sources (Pi-owned local mode)

OM/recall stripping requires `blackhole.generatedSpans` version-1 proof: actual insertion offsets, SHA-256 span digests, full-summary sourceGeneration and exact latest summary/trailing agreement. User-quoted `## Observations`, `## Reflections` and recall/footer markers remain literal. Unproved legacy/native text is not backfilled or deleted. Source-proven observations become stale on active canonical source omission/redaction/replacement; dependent reflections are filtered too. Out-of-window historical sources are not redactions. Proven invalidation carries across checkpoints, including state-only generation-bound markers after successful native fallback; it does not enter model messages, and raw history/old unproved transitive text remain available. Full historical selective erasure without provenance is not promised.

## OM coupling

When expanding session entries (`#N`), the tool automatically looks up related observations and reflections from the session ledger. Defined in [[src/om/reverse-recall.ts]].

- `findObservationsForEntryIds()` — Finds observations whose `sourceEntryIds` intersect with the expanded entries
- `findReflectionsForEntryIds()` — Finds reflections that support those observations (via `supportingObservationIds`)
- Results annotated with `#N` indices via `buildIndexMap()` + `formatEntryIndexAnnotation()`

OM integration is wrapped in try/catch — branch may not be available in all contexts. Dropped observations included with `[dropped]` marker.

## /blackhole-recall command

User-facing command for interactive session history search. Defined in [[src/commands/vcc-recall.ts]]. Same engine as the `recall` tool.

The command renders to the TUI for the human operator, so it is intentionally not covered by the `recallResponseMaxChars` total budget (per-entry snippet/body clips still apply via the shared modules). Capping user-facing command output is a separate follow-up.

```
/blackhole-recall auth token                        # active-lineage search, ranked
/blackhole-recall auth token page:2                 # paginated (5 results/page)
/blackhole-recall hook|inject                       # regex
/blackhole-recall fail.*build scope:all             # regex across all lineages
/blackhole-recall mode:file                         # search only write/edit file content
/blackhole-recall mode:touched                      # aggregate view of all files touched
/blackhole-recall                                   # recent 25 entries
```

Results shown as a collapsible message and auto-fed to the agent as context. Calls `augmentWithObservations()` after rendering to append related OM observations/reflections.

## Session file access

Legacy message access goes through `loadAllMessages()`; notification evidence uses its separate bounded JSONL scanner without modifying legacy message arrays/counting rule. `loadAllMessages()` in [[src/core/load-messages.ts]]. LRU cache:

- Max 3 entries
- 2-second TTL
- mtime-based invalidation (detects file changes between cache hits)
- Cache key includes `allowedEntryIds` set (sorted JSON for collision-free lineage filtering)
- Parse errors logged via `console.warn()` but don't throw

## Content indexing

Full-file writes and successful native Note content are indexed for text search. Existing content-bearing argument heuristics are unchanged for other tools; unsuccessful file proposals may remain historical searchable text. Tool-argument extraction is capped at 10,240 characters per call; explicit stored-content drill-down keeps its separate display/response budgets.

### Content formatting

`formatRecallOutput()` in [[src/core/format-recall.ts]] formats search results:

- `shortPath()` — Shorten paths relative to CWD or show last 3 components
- `formatFileMatch()` — Tool name, path, line count, optional snippet
- `formatTouchedOutput()` — Paginated file-touch list (5 per page)
