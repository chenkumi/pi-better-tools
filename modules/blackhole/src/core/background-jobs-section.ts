/**
 * Live "[Background Jobs]" reminder for a compaction summary.
 *
 * Local Pi Better Tools addition. The data is the readonly id/status list that Shell, Subagents, Fork and PTY publish
 * through the Monitor capability rendezvous (PTY sessions arrive as brief-only rows): no commands, task text, output or paths. It describes the moment of
 * compaction only, so it is a generated `jobs` span that later compactions strip instead of carrying forward.
 */
import { activeJobBriefs, canonicalMonitorCwd, type ActiveJobBrief } from "../../../shell-tools/src/monitor-capability.js";

const MAX_ROWS = 16;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_STATUS = /^[a-z_]{1,32}$/;
const PTY_HINT = "PTY sessions are interactive programs that may be waiting for input: check them with pty_list or pty_read, and do not spawn a duplicate.";
const LABEL: Record<ActiveJobBrief["kind"], string> = { shell_job: "Shell Job", subagent_job: "Subagent Job", fork_job: "Fork Job", pty_session: "PTY Session" };

export function renderBackgroundJobs(briefs: readonly ActiveJobBrief[], partial: boolean): string {
  const rows: string[] = [];
  let lost = partial;
  // Valid rows per kind, then taken round-robin so one busy kind cannot crowd the others out of the cap.
  const byKind = new Map<string, string[]>();
  for (const brief of briefs) {
    if (!LABEL[brief.kind] || !SAFE_ID.test(brief.jobId) || !SAFE_STATUS.test(brief.status)) { lost = true; continue; }
    const list = byKind.get(brief.kind) ?? [];
    list.push(`- ${LABEL[brief.kind]}: ${brief.jobId} (${brief.status})`);
    byKind.set(brief.kind, list);
  }
  const queues = [...byKind.values()];
  for (let i = 0; rows.length < MAX_ROWS && queues.some(q => i < q.length); i++) {
    for (const q of queues) if (i < q.length && rows.length < MAX_ROWS) rows.push(q[i]);
  }
  if (rows.length < queues.reduce((n, q) => n + q.length, 0)) lost = true;
  if (!rows.length && !lost) return "";
  return [
    "[Background Jobs — live at compaction time; status may have changed since]",
    ...rows,
    ...(lost ? ["- (partial: some jobs were omitted or unreadable)"] : []),
    "These were still unfinished when this summary was written. Check them with the job status tools before acting; do not assume they are still running, and do not restart work that is already in progress.",
    ...(rows.some(row => row.startsWith(`- ${LABEL.pty_session}:`)) ? [PTY_HINT] : []),
  ].join("\n");
}

/** Best effort: any failure yields no section. Providers only read in-memory lists synchronously, so this stays cheap. */
export function backgroundJobsSection(sessionId: string | undefined, cwd: string): string {
  try {
    if (!sessionId) return "";
    const { briefs, partial } = activeJobBriefs({ sessionId, cwd: canonicalMonitorCwd(cwd) });
    return renderBackgroundJobs(briefs, partial);
  } catch { return ""; }
}
