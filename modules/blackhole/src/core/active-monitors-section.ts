/**
 * Live "[Active Monitors]" reminder for a compaction summary.
 *
 * Local Pi Better Tools addition. The data is the readonly live-monitor list the Monitor extension publishes through
 * the Monitor capability rendezvous: source kind, state, a coarse target (workspace-relative file path, origin, job id,
 * or a withholding marker), the optional user label and the remaining lifetime — never command text, output or events.
 * It describes the moment of compaction only, so it is a generated `monitors` span that later compactions strip
 * instead of carrying forward.
 */
import { activeMonitorBriefs, canonicalMonitorCwd, MAX_ACTIVE_MONITOR_BRIEFS, type ActiveMonitorBrief } from "../../../shell-tools/src/monitor-capability.js";

const MAX_ROWS = MAX_ACTIVE_MONITOR_BRIEFS;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_STATE = /^[a-z_]{1,32}$/;
const SOURCE_LABEL: Record<string, string> = { command: "Command", websocket: "WebSocket", file: "File", shell_job: "Shell Job", subagent_job: "Subagent Job", fork_job: "Fork Job" };
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/** Targets and labels are owner-supplied text, so they are stripped again here before they reach summary prose. */
function clean(value: string, max: number): string {
  return value.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function remaining(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown time left";
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 ? `${Math.floor(seconds / 60)}m left` : `${seconds}s left`;
}

export function renderActiveMonitors(briefs: readonly ActiveMonitorBrief[], partial: boolean): string {
  const rows: string[] = [];
  let lost = partial;
  for (const brief of briefs) {
    const label = SOURCE_LABEL[brief.source];
    if (!label || !SAFE_ID.test(brief.monitorId) || !SAFE_STATE.test(brief.state)) { lost = true; continue; }
    const target = clean(brief.target, 300) || "(target unavailable)";
    const owner = brief.label ? ` — label: ${clean(brief.label, 80) || "(blank)"}` : "";
    rows.push(`- ${label}: ${target} (${brief.state}, ${remaining(brief.remainingMs)}) — id ${brief.monitorId}${owner}`);
  }
  if (rows.length > MAX_ROWS) { rows.length = MAX_ROWS; lost = true; }
  if (!rows.length && !lost) return "";
  return [
    "[Active Monitors — live at compaction time; state may have changed since]",
    ...rows,
    ...(lost ? ["- (partial: some monitors were omitted or unreadable)"] : []),
    "These monitors were still running when this summary was written. Check them with monitor_status before acting; do not assume they are still running, and do not stop or restart their sources from this summary.",
  ].join("\n");
}

/** Best effort: any failure yields no section. The reader only projects in-memory receipts synchronously, so this stays cheap. */
export function activeMonitorsSection(sessionId: string | undefined, cwd: string): string {
  try {
    if (!sessionId) return "";
    const { briefs, partial } = activeMonitorBriefs({ sessionId, cwd: canonicalMonitorCwd(cwd) });
    return renderActiveMonitors(briefs, partial);
  } catch { return ""; }
}
