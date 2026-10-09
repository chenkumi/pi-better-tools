import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, buildSessionProjection } from "@earendil-works/pi-coding-agent";
// Test-only readonly import of the actual installed Pi algorithm; no SDK patch.
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
import { nativeEvidenceEntries } from "../../src/core/native-compaction-input.js";
import { notificationEvidenceSummary } from "../../src/core/notification-evidence.js";
import { buildPreCompactionOutputData } from "../../src/hooks/cosmetic-output.js";
import { stripOMContent, stripRecallNotes, compile } from "../../src/core/summarize.js";
import { registerBeforeCompactHook } from "../../src/hooks/before-compact.js";
import { DEFAULTS, loadUnifiedConfig } from "../../src/core/unified-config.js";
import { config } from "../../src/pi-base/blackhole-settings.js";
import { buildCompactionProjection } from "../../src/om/ledger/projection.js";
import { composeGeneratedParts, ownedSummaryProof, stripGeneratedSpans, type GeneratedSummaryProof } from "../../src/core/generated-summary-spans.js";
import { nativeEligibleEdits, nativeContextEntries, nativeCompactionInput } from "../../src/core/native-compaction-input.js";
import { notificationEvidenceMetadata, EVIDENCE_METADATA_KEY } from "../../src/core/notification-evidence.js";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const assistant = (text: string): any => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1, api: "openai-responses", provider: "offline", model: "offline", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const sm = () => SessionManager.inMemory(process.cwd());
const notice = (manager: any, id: string) => manager.appendCustomMessageEntry("shell-job-completed", "job", false, { jobs: [{ jobId: id, status: "completed", exitCode: 0 }] });
it("C1 actual Pi invisible-backtrack cut keeps null-notification coordinates, never retained evidence", () => {
  const s = sm(); s.appendMessage({ role: "user", content: "old task", timestamp: 1 }); s.appendMessage(assistant("old result"));
  const n = notice(s, "OMITTED"); s.appendContextEdit(n, null);
  s.appendMessage({ role: "user", content: "kept ".repeat(500), timestamp: 1 }); const n2 = notice(s, "RETAINED");
  const p = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 })!;
  expect(p.firstKeptEntryId).toBe(n);
  const effective = nativeEvidenceEntries(s.getBranch());
  expect(effective.some(e => e.id === n)).toBe(true);
  expect(notificationEvidenceSummary(effective, p.firstKeptEntryId)).not.toContain(`e:${n2}`);
});
it("C1 unknown nonempty cut never widens evidence to branch tip", () => {
  const s = sm(); notice(s, "RETAINED"); const text = notificationEvidenceSummary(s.getBranch(), "UNKNOWN");
  expect(text).not.toContain("e:"); expect(text).toMatch(/unknown|unproven|boundary/i); expect(text.length).toBeLessThan(500);
});
it.each([null, { content: "REDACTED" }])("W1 canonical active assistant edit controls display copy %j", edit => {
  const s = sm(); s.appendMessage({ role: "user", content: "task", timestamp: 1 });
  const a = s.appendMessage(assistant("PRIVATE_OUTPUT_SENTINEL")); s.appendContextEdit(a, edit);
  notice(s, "VISIBLE_BOUNDARY_SEPARATOR");
  const k = s.appendMessage({ role: "user", content: "keep ".repeat(500), timestamp: 1 });
  const preparation = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 })!;
  expect(preparation.firstKeptEntryId).toBe(k);
  const c = s.appendCompaction("summary", preparation.firstKeptEntryId, preparation.tokensBefore);
  const data = buildPreCompactionOutputData({ branch: s.getBranch(), retainedIds: new Set(s.buildContextEntries().map(e => e.id)), compactionEntry: { id: c } });
  if (edit === null) expect(data).toBeUndefined(); else expect(data?.text).toBe("REDACTED");
});
it("W2 unproved literal OM headers and recall quotations survive stripping and native merge", () => {
  const om = "Progress\n## Observations\nKeep deployment blocked";
  const recall = "Keep deployment blocked: The conversation before this point has been compacted";
  expect(stripOMContent(om)).toBe(om); expect(stripRecallNotes(recall)).toBe(recall);
  expect(compile({ messages: [ { role: "user", content: "new task", timestamp: 1 } ], previousSummary: om + "\n\n" + recall })).toContain("Keep deployment blocked");
});
it.each([null, { content: "REDACTED" }])("W3 real native preparation source edit invalidates derived OM and dependent reflection %j", edit => {
  const s = sm(); const source = s.appendMessage({ role: "user", content: "PRIVATE_OM_SENTINEL", timestamp: 1 });
  s.appendMessage(assistant("result"));
  s.appendCustomEntry("om.observations.recorded", { coversUpToId: source, observations: [{ id: "aaaaaaaaaaaa", content: "PRIVATE_OM_SENTINEL", timestamp: "2026-10-09", relevance: "high", sourceEntryIds: [source], tokenCount: 10 }] });
  s.appendCustomEntry("om.reflections.recorded", { coversUpToId: source, reflections: [{ id: "bbbbbbbbbbbb", content: "PRIVATE_OM_SENTINEL", supportingObservationIds: ["aaaaaaaaaaaa"], tokenCount: 10 }] });
  s.appendContextEdit(source, edit); s.appendMessage({ role: "user", content: "safe task", timestamp: 1 }); s.appendMessage(assistant("safe result"));
  s.appendMessage({ role: "user", content: "kept ".repeat(500), timestamp: 1 });
  const preparation = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 })!;
  let handler: any; registerBeforeCompactHook({ on: (name: string, h: any) => { if (name === "session_before_compact") handler = h; } } as any, { config: { ...DEFAULTS, memory: true, fullFoldAlways: true }, ensureConfig() {} } as any);
  const result = handler({ preparation, branchEntries: s.getBranch(), signal: new AbortController().signal }, { cwd: process.cwd(), sessionManager: s, ui: { notify() {} } });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_OM_SENTINEL"); expect(result.compaction.details["om.folded"].observations).toEqual([]); expect(result.compaction.details["om.folded"].reflections).toEqual([]);
});
it("UI active fields describe Pi-only timing and ignored legacy controls", () => {
  const fields = (config as any).opts.fields(DEFAULTS);
  expect(fields.find((f: any) => f.key === "compaction").description).toMatch(/summary/i);
  for (const key of ["tailBehavior", "midRunCompaction", "compactAfterTokens", "compactAfterRatio", "compactReserveTokens", "compactAfterPreset", "retainedToolOutputMaxTokens"]) expect(fields.find((f: any) => f.key === key).description).toMatch(/legacy.*ignored|ignored.*Pi/i);
});
it("PASSIVE defaults precede explicit env and empty/session overrides, modal load agrees with unified", () => {
  const d = mkdtempSync(join(tmpdir(), "bh-review-config-")); dirs.push(d); const cwd = join(d, "workspace"), global = join(d, "pi-blackhole"); mkdirSync(cwd); mkdirSync(global);
  vi.stubEnv("PI_CODING_AGENT_DIR", d); vi.stubEnv("PI_BLACKHOLE_PASSIVE", "true"); vi.stubEnv("PI_BLACKHOLE_COMPACTION", "auto");
  writeFileSync(join(global, "pi-blackhole-config.json"), JSON.stringify({ memory: false, compaction: "auto" }));
  const s = sm(); const id = s.appendMessage({ role: "user", content: "init", timestamp: 1 });
  config.initSession(s.getSessionId(), id, s.getEntries() as any, (type, data) => s.appendCustomEntry(type, data), () => s.getEntries() as any);
  expect(loadUnifiedConfig(cwd).compaction).toBe("auto"); expect(config.load(cwd, global).compaction).toBe("auto");
  const override = s.appendCustomEntry("session-config-pi-blackhole", { compaction: "manual", memory: true });
  // ConfigManager's real persisted entry envelope is established by its public save.
  config.initSession(s.getSessionId(), override, s.getEntries() as any, (type, data) => s.appendCustomEntry(type, data), () => s.getEntries() as any);
  config.save({ compaction: "manual", memory: true }, "session", cwd, global);
  expect(config.load(cwd, global)).toMatchObject({ compaction: "manual", memory: true });
  vi.stubEnv("PI_BLACKHOLE_COMPACT_AFTER_TOKENS", "81000");
  expect(config.load(cwd, global).compactAfterTokens).toBe(81000);
  const resolved = config.loadWithWarnings(cwd, global); expect(resolved.warnings.some(w => w.message.includes("Pi owns compaction"))).toBe(true);
  const notify = vi.fn(); config.notifyWarnings(resolved, notify); config.notifyWarnings(config.loadWithWarnings(cwd, global), notify);
  expect(notify.mock.calls.filter(([text]) => text.includes("Pi owns compaction"))).toHaveLength(1);
});

function nativeHook(s: any, options: any = {}) {
  const preparation = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 });
  let handler: any;
  registerBeforeCompactHook({ on: (name: string, h: any) => { if (name === "session_before_compact") handler = h; } } as any, { config: { ...DEFAULTS, memory: true, fullFoldAlways: true, ...options }, ensureConfig() {} } as any);
  return { preparation, result: handler({ preparation, branchEntries: s.getBranch(), signal: new AbortController().signal }, { cwd: process.cwd(), sessionManager: s, ui: { notify() {} } }) };
}
function memoryBranch() {
  const s = sm(), source = s.appendMessage({ role: "user", content: "PRIVATE_OM_SENTINEL", timestamp: 1 }); s.appendMessage(assistant("result"));
  s.appendCustomEntry("om.observations.recorded", { coversUpToId: source, observations: [{ id: "aaaaaaaaaaaa", content: "PRIVATE_OM_SENTINEL", timestamp: "2026-10-09", relevance: "high", sourceEntryIds: [source], tokenCount: 10 }] });
  return { s, source };
}
it("W3 prior verified invalidation survives its edit falling outside the next checkpoint window", () => {
  const { s, source } = memoryBranch(); s.appendContextEdit(source, null);
  s.appendMessage({ role: "user", content: "safe", timestamp: 1 }); s.appendMessage(assistant("safe result"));
  s.appendMessage({ role: "user", content: "keep ".repeat(500), timestamp: 1 });
  const { result } = nativeHook(s); expect(result.compaction.summary).not.toContain("PRIVATE_OM_SENTINEL");
  s.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details);
  expect(nativeEligibleEdits(s.getBranch()).has(source)).toBe(false);
  s.appendMessage(assistant("second safe result")); s.appendMessage({ role: "user", content: "keep next ".repeat(500), timestamp: 1 });
  const next = nativeHook(s, { compactionSummaryMode: "append" }).result;
  expect(JSON.stringify(next)).not.toContain("PRIVATE_OM_SENTINEL");
});

it("C1 active checkpoint edits match canonical Pi eligibility; inactive raw edits do not revive authority", () => {
  const s = sm(); const old = notice(s, "OLD_RAW_METADATA"); s.appendContextEdit(old, null);
  const kept = s.appendMessage({ role: "user", content: "kept", timestamp: 1 });
  s.appendCompaction("native checkpoint", kept, 100); const replacement = { content: "SAFE_REPLACED_NOTICE" };
  s.appendContextEdit(old, replacement);
  expect(nativeEligibleEdits(s.getBranch()).get(old)).toEqual(replacement);
  expect(nativeEligibleEdits(s.getBranch())).toEqual(nativeEligibleEdits(s.buildContextEntries()));
  expect(s.buildSessionProjection().messages.some((m: any) => m.role === "custom" && m.customType === "shell-job-completed")).toBe(false);
  const effective = nativeEvidenceEntries(s.getBranch());
  const boundary = effective.find(e => e.id === old)!; expect(boundary.type).toBe("custom"); expect(boundary).not.toHaveProperty("details");
  expect(notificationEvidenceSummary(effective, kept)).not.toContain("OLD_RAW_METADATA");
  expect(notificationEvidenceSummary(effective, old)).toBe("");
});
it("C1 unknown and duplicate cut coordinates emit bounded diagnostics without invented refs/coverage", () => {
  const s = sm(); const id = notice(s, "ONE"); const branch = s.getBranch();
  for (const [entries, cut] of [[branch, "unknown"], [[...branch, { ...branch.at(-1) }], id]] as any[]) {
    const text = notificationEvidenceSummary(entries, cut); expect(text.length).toBeLessThan(500); expect(text).not.toMatch(/e:[A-Za-z0-9_-]|#\d|coverage:|sourceMessages=/i); expect(text).toMatch(/boundary/i);
  }
});
it.each([null, { content: "REPLACED_NOTICE_SENTINEL", details: { jobs: [{ jobId: "FAKE_NEW_AUTHORITY", status: "completed" }] } }])("C1 actual notification edits remove stale structured authority, previous proof cannot resurrect it %j", edit => {
  const s = sm(); const n = notice(s, "OLD_AUTHORITY_SENTINEL"); const proofSection = notificationEvidenceSummary(s.getBranch(), "");
  const proof = notificationEvidenceMetadata(proofSection, proofSection, undefined, { summary: 0 });
  const k = s.appendMessage({ role: "user", content: "keep", timestamp: 1 });
  expect(proof).toBeDefined();
  s.appendCompaction(proofSection, k, 100, { compactor: "blackhole", version: 1, [EVIDENCE_METADATA_KEY]: proof });
  expect(notificationEvidenceSummary(nativeEvidenceEntries(s.getBranch()), "", proofSection)).toContain("OLD_AUTHORITY_SENTINEL");
  s.appendContextEdit(n, edit);
  const text = notificationEvidenceSummary(nativeEvidenceEntries(s.getBranch()), "", proofSection);
  expect(text).not.toContain("OLD_AUTHORITY_SENTINEL"); expect(text).not.toContain("FAKE_NEW_AUTHORITY"); expect(text).not.toContain(`e:${n}`);
});
it("native split prefix keeps complete actual assistant-call/tool-result pairs and source indices", () => {
  const s = sm(); s.appendMessage({ role: "user", content: "execute paired tools", timestamp: 1 });
  const call = s.appendMessage({ ...assistant(""), content: [{ type: "toolCall", id: "call_one", name: "read", arguments: { path: "safe.ts" } }], stopReason: "toolUse" });
  const result = s.appendMessage({ role: "toolResult", toolCallId: "call_one", toolName: "read", content: [{ type: "text", text: "paired result" }], isError: false, timestamp: 1 });
  s.appendMessage(assistant("kept final ".repeat(500)));
  const p = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 })!;
  expect(p.turnPrefixMessages.length).toBeGreaterThan(0);
  const input = nativeCompactionInput(p, s.getBranch(), s.buildSessionProjection());
  expect(input.messages.some((m: any) => m.role === "toolResult" && m.toolCallId === "call_one")).toBe(true);
  expect(input.messages.some((m: any) => m.content?.some?.((part: any) => part.type === "toolCall" && part.id === "call_one"))).toBe(true);
  expect(input.selectedIds).toContain(call); expect(input.selectedIds).toContain(result);
});
it("W1 persisted native cut preserves normal dropped finals, excludes kept/duplicate IDs and leaves raw history unchanged", () => {
  const s = sm(); s.appendMessage({ role: "user", content: "old task", timestamp: 1 }); const a = s.appendMessage(assistant("NORMAL_FINAL"));
  notice(s, "BOUNDARY"); s.appendMessage({ role: "user", content: "keep ".repeat(500), timestamp: 1 });
  const p = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 })!, before = JSON.stringify(s.getBranch());
  const c = s.appendCompaction("summary", p.firstKeptEntryId, p.tokensBefore);
  const branch = s.getBranch(), cpIndex = branch.findIndex(e => e.id === c);
  const options = { branch, retainedIds: new Set(s.buildContextEntries().map(e => e.id)), compactionEntry: { id: c } };
  expect(buildPreCompactionOutputData(options)?.sourceEntryId).toBe(a);
  expect(buildPreCompactionOutputData({ ...options, retainedIds: new Set([a]) })).toBeUndefined();
  expect(buildPreCompactionOutputData({ ...options, branch: [...branch.slice(0, cpIndex), { ...branch.find(e => e.id === a)! }, ...branch.slice(cpIndex)] })).toBeUndefined();
  expect(JSON.stringify(s.getBranch().slice(0, cpIndex))).toBe(before);
});
it("W1 an actual post-persistence active null edit blocks display reinsertion too", () => {
  const s = sm(); s.appendMessage({ role: "user", content: "old safe task", timestamp: 1 }); const a = s.appendMessage(assistant("PRIVATE_POST_PERSIST_OUTPUT"));
  notice(s, "BOUNDARY"); s.appendMessage({ role: "user", content: "keep ".repeat(500), timestamp: 1 });
  const p = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 })!;
  const c = s.appendCompaction("summary", p.firstKeptEntryId, p.tokensBefore); s.appendContextEdit(a, null);
  expect(buildPreCompactionOutputData({ branch: s.getBranch(), retainedIds: new Set(s.buildContextEntries().map(e => e.id)), compactionEntry: { id: c } })).toBeUndefined();
});
it("W3 an out-of-window source is not a redaction and an inactive legacy raw edit is not active proof", () => {
  const { s, source } = memoryBranch();
  s.appendContextEdit(source, null); const kept = s.appendMessage({ role: "user", content: "keep", timestamp: 1 });
  s.appendCompaction("unproved native checkpoint", kept, 100);
  expect(nativeEligibleEdits(s.getBranch()).has(source)).toBe(false);
  const projected = buildCompactionProjection(s.getBranch() as any, "", { observationsPoolMaxTokens: 1000, reflectionsPoolMaxTokens: 1000, fullFoldAlways: true });
  expect(projected.details.observations[0].sourceEntryIds).toEqual([source]); expect(projected.observations[0].content).toBe("PRIVATE_OM_SENTINEL");
});
it("W2 offset/hash/source-generation proof strips only actual composed spans, preserving identically quoted markers", () => {
  const quoted = "## Observations\nKeep deployment blocked\nThe conversation before this point has been compacted";
  const composed = composeGeneratedParts([{ text: quoted }, { text: "## Observations\nOWNED_ONLY", kind: "om" }, { text: "OWNED_RECALL", kind: "recall" }]);
  const s = sm(); s.appendCompaction(composed.text, "", 10, { compactor: "blackhole", 'blackhole.generatedSpans': { version: 1, summary: composed.proof } });
  expect(stripGeneratedSpans(composed.text, ownedSummaryProof(composed.text, s.getBranch()))).toContain(quoted);
  expect(stripGeneratedSpans(composed.text, composed.proof)).not.toContain("OWNED_ONLY");
  const shifted = { ...composed.proof, spans: composed.proof.spans.map(span => ({ ...span, offset: 0 })) };
  expect(stripGeneratedSpans(composed.text, shifted)).toBe(composed.text);
  expect(stripGeneratedSpans(composed.text + "different generation", composed.proof)).toBe(composed.text + "different generation");
  expect(ownedSummaryProof(composed.text + "different generation", s.getBranch())).toBeUndefined();
});


