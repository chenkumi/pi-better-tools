/**
 * JobsView — single TUI overlay that consolidates view + add + toggle + remove
 * + cleanup for scheduled prompts. Foreign-session jobs render read-only in a
 * separate group; actions (t/x/c) ignore them.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { CronScheduler } from "../scheduler.js";
import { deadlineLabel, validateJobDeadline } from "../deadline.js";
import type { CronStorage } from "../storage.js";
import type { CronJob } from "../types.js";
import { commandLabel } from "../command.js";
import { commandApprovalText, toggleReviewedJob } from "./job-approval.js";

type ConfirmState =
  | { kind: "remove"; id: string; name: string }
  | { kind: "cleanup"; count: number };

/** Approving a command needs the whole spec on screen: paged, and only after every page was displayed. */
type ReviewState = {
  job: CronJob;
  page: number;
  pages: number;
  rendered: { geometry: string; page: number; pages: number } | null;
};

const DEFAULT_ROWS = 24;

const NAME_W = 18;
const SCHED_W = 16;
const PROMPT_W = 30;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.substring(0, n - 3)}...` : s;
}

export class JobsView implements Component {
  private mine: CronJob[] = [];
  private foreign: CronJob[] = [];
  private selectedIndex = 0;
  private confirm: ConfirmState | null = null;
  private review: ReviewState | null = null;
  private actionError?: string;

  constructor(
    private storage: CronStorage,
    private scheduler: CronScheduler,
    private mySessionId: string | undefined,
    private runAdd: () => Promise<void>,
    private theme: any,
    private requestRender: () => void,
    private done: () => void,
    private runAddCommand?: () => Promise<void>,
    private rows?: () => number,
  ) {
    this.refresh();
  }

  invalidate(): void {
    // No cached render output.
  }

  private refresh(): void {
    const all = this.storage.getAllJobs();
    this.mine = all.filter((j) => CronScheduler.isLoadedFor(j, this.mySessionId));
    this.foreign = all.filter((j) => !CronScheduler.isLoadedFor(j, this.mySessionId));
    const max = Math.max(0, this.mine.length + this.foreign.length - 1);
    if (this.selectedIndex > max) this.selectedIndex = max;
  }

  private selectedJob(): CronJob | undefined {
    return this.selectedIndex < this.mine.length
      ? this.mine[this.selectedIndex]
      : this.foreign[this.selectedIndex - this.mine.length];
  }

  private isSelectionForeign(): boolean {
    return this.selectedIndex >= this.mine.length;
  }

  handleInput(data: string): void {
    if (this.review) {
      this.handleReviewInput(data);
      return;
    }
    if (this.confirm) {
      this.handleConfirmInput(data);
      return;
    }
    this.handleNormalInput(data);
  }

  /** One page turn per displayed page, so a batched arrow burst cannot skip content nobody saw. */
  private handleReviewInput(data: string): void {
    const review = this.review!;
    if (matchesKey(data, "n") || matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.review = null;
      this.requestRender();
      return;
    }
    const displayed = review.rendered !== null;
    if (matchesKey(data, "right")) {
      if (displayed && review.page < review.pages) { review.page++; review.rendered = null; this.requestRender(); }
      return;
    }
    if (matchesKey(data, "left")) {
      if (displayed && review.page > 1) { review.page--; review.rendered = null; this.requestRender(); }
      return;
    }
    if (!matchesKey(data, "y")) return;
    // Approval needs the last page of the current geometry on screen: an early y reviews nothing.
    if (!displayed || review.page !== review.pages) return;
    this.review = null;
    try {
      toggleReviewedJob(this.storage, this.scheduler, review.job, this.mySessionId);
      this.actionError = undefined;
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
    }
    this.refresh();
    this.requestRender();
  }

  private handleConfirmInput(data: string): void {
    if (matchesKey(data, "y")) {
      if (this.confirm?.kind === "remove") {
        this.storage.removeJob(this.confirm.id);
        this.scheduler.removeJob(this.confirm.id);
      } else if (this.confirm?.kind === "cleanup") {
        for (const j of this.storage.removeDisabledJobs(this.mySessionId)) this.scheduler.removeJob(j.id);
      }
      this.confirm = null;
      this.refresh();
      return;
    }
    if (matchesKey(data, "n") || matchesKey(data, "escape")) {
      this.confirm = null;
    }
  }

  private handleNormalInput(data: string): void {
    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex > 0) this.selectedIndex--;
      return;
    }
    if (matchesKey(data, "down")) {
      const max = this.mine.length + this.foreign.length - 1;
      if (this.selectedIndex < max) this.selectedIndex++;
      return;
    }
    if (matchesKey(data, "m") && this.runAddCommand) {
      this.runAddCommand()
        .catch((err) => console.error("[pi-schedule-prompt] add command flow failed:", err))
        .finally(() => {
          this.refresh();
          this.requestRender();
        });
      return;
    }
    if (matchesKey(data, "a")) {
      this.runAdd()
        .catch((err) => console.error("[pi-schedule-prompt] add flow failed:", err))
        .finally(() => {
          this.refresh();
          this.requestRender();
        });
      return;
    }

    const sel = this.selectedJob();
    if (!sel) return;

    if (matchesKey(data, "t")) {
      if (this.isSelectionForeign()) return;
      const fresh = this.storage.getJob(sel.id);
      if (!fresh || !CronScheduler.isLoadedFor(fresh, this.mySessionId)) return;
      const enabled = !fresh.enabled;
      try {
        if (enabled) validateJobDeadline(fresh);
        this.actionError = undefined;
      } catch (error) {
        this.actionError = error instanceof Error ? error.message : String(error);
        this.requestRender();
        return;
      }
      // The row and details show the exact command and directory; enabling it here is the person's explicit act.
      // A command needs the whole spec reviewed first; the reviewed snapshot is what the view displayed, so a
      // peer that changed the job meanwhile wins over the stale review instead of enabling an unseen command.
      if (enabled && fresh.command !== undefined) {
        this.review = { job: sel, page: 1, pages: 1, rendered: null };
        this.requestRender();
        return;
      }
      try {
        toggleReviewedJob(this.storage, this.scheduler, sel, this.mySessionId);
        this.actionError = undefined;
      } catch (error) {
        this.actionError = error instanceof Error ? error.message : String(error);
      }
      this.refresh();
      return;
    }
    if (matchesKey(data, "s")) {
      // Toggle this job's binding: session-bound ↔ shared. Other pi sessions
      // already running in this cwd won't see the change until they restart;
      // their in-memory schedulers are stale until session_start.
      if (this.isSelectionForeign()) return;
      const session = sel.session ? undefined : this.mySessionId;
      this.storage.updateJob(sel.id, { session });
      this.scheduler.updateJob(sel.id, { ...sel, session });
      this.refresh();
      return;
    }
    if (matchesKey(data, "x")) {
      if (this.isSelectionForeign()) return;
      this.confirm = { kind: "remove", id: sel.id, name: sel.name };
      return;
    }
    if (matchesKey(data, "c")) {
      const count = this.mine.filter((j) => !j.enabled).length;
      if (count === 0) return;
      this.confirm = { kind: "cleanup", count };
    }
  }

  render(width: number): string[] {
    if (this.review) return this.renderReview(width);
    const lines: string[] = [];
    const total = this.mine.length + this.foreign.length;
    const rule = this.theme.fg("dim", "─".repeat(Math.max(1, width)));

    lines.push(rule);

    // Header (or active confirm prompt — overrides the hint line)
    if (this.confirm?.kind === "remove") {
      lines.push(this.theme.fg("warning", ` Remove "${this.confirm.name}"? (y/n)`));
    } else if (this.confirm?.kind === "cleanup") {
      lines.push(
        this.theme.fg(
          "warning",
          ` Remove ${this.confirm.count} disabled job(s) in this session? (y/n)`,
        ),
      );
    } else if (total === 0) {
      lines.push(` ${this.theme.fg("accent", this.theme.bold("Jobs"))}  —  a add   q quit`);
    } else {
      lines.push(
        ` ${this.theme.fg("accent", this.theme.bold("Jobs"))}  —  ↑↓ select   a add   m add command   t toggle   s scope   x remove   c cleanup   q quit`,
      );
    }
    lines.push(rule);
    if (this.actionError) lines.push(this.theme.fg("error", truncateToWidth(this.actionError, Math.max(1, width))));

    if (total === 0) {
      lines.push("");
      lines.push("  No scheduled prompts. Press `a` to add one or `q` to quit.");
      lines.push("");
      lines.push(rule);
      return lines;
    }

    for (let i = 0; i < this.mine.length; i++) {
      lines.push(this.formatRow(this.mine[i], i, false));
    }

    if (this.foreign.length > 0) {
      lines.push("");
      lines.push(this.theme.fg("dim", "  Other sessions (read-only):"));
      for (let i = 0; i < this.foreign.length; i++) {
        lines.push(this.formatRow(this.foreign[i], this.mine.length + i, true));
      }
    }

    const sel = this.selectedJob();
    if (sel) {
      lines.push(rule);
      const next = !this.isSelectionForeign() ? this.scheduler.getNextRun(sel.id) : null;
      const meta = [
        `Type: ${sel.type}`,
        next ? `Next: ${next.toISOString()}` : null,
        sel.lastRun ? `Last: ${sel.lastRun}` : null,
        `Runs: ${sel.runCount}`,
      ]
        .filter(Boolean)
        .join("   ");
      lines.push(this.theme.fg("dim", ` Selected: ${sel.name} (${sel.id})`));
      lines.push(this.theme.fg("dim", ` ${meta}`));
      lines.push(this.theme.fg("dim", truncateToWidth(` ${deadlineLabel(sel.endAt)}`, Math.max(1, width))));
      if (sel.command !== undefined) {
        lines.push(this.theme.fg("dim", truncateToWidth(` ${commandLabel(sel)}`, Math.max(1, width))));
        lines.push(this.theme.fg("dim", truncateToWidth(` Directory: ${sel.cwd ?? "(project directory)"}`, Math.max(1, width))));
      } else {
        lines.push(this.theme.fg("dim", ` Prompt: ${truncate(sel.prompt ?? "", 200)}`));
      }
    }
    lines.push(rule);

    return lines;
  }

  /** Full spec, wrapped and paged; a geometry change invalidates the pages the person already saw. */
  private renderReview(width: number): string[] {
    const review = this.review!;
    const rows = Math.max(2, this.rows?.() ?? DEFAULT_ROWS), capacity = Math.max(1, rows - 2);
    const body = this.reviewBody(review.job, width);
    review.pages = Math.max(1, Math.ceil(body.length / capacity));
    const geometry = `${width}x${rows}`;
    if (review.rendered && review.rendered.geometry !== geometry) review.page = 1;
    if (review.page > review.pages) review.page = review.pages;
    const start = (review.page - 1) * capacity;
    const lines = [
      this.theme.fg("warning", truncateToWidth(` Confirm enabling scheduled command   Page ${review.page}/${review.pages}`, Math.max(1, width))),
      ...body.slice(start, start + capacity),
      this.theme.fg("dim", truncateToWidth(" ←/→ review   y approve   n cancel", Math.max(1, width))),
    ];
    if (this.actionError) lines.push(this.theme.fg("error", truncateToWidth(this.actionError, Math.max(1, width))));
    review.rendered = { geometry, page: review.page, pages: review.pages };
    return lines.slice(0, rows);
  }

  private reviewBody(job: CronJob, width: number): string[] {
    const text = [`Enable "${job.name}"?`, ...commandApprovalText(job).split("\n")].join("\n");
    const limit = Math.max(1, width), out: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.length) { out.push(line); continue; }
      for (let at = 0; at < line.length; at += limit) out.push(line.slice(at, at + limit));
    }
    return out;
  }

  private formatRow(job: CronJob, index: number, isForeign: boolean): string {
    const indicator = index === this.selectedIndex ? "▶" : " ";

    // Foreign rows are colorless (the surrounding `Other sessions` label and
    // dim-styled selected-details footer carry the visual cue). Embedding a
    // colored icon inside a dim-wrapped string produces nested ANSI which some
    // terminals render inconsistently — keeping foreign rows uncolored avoids
    // that class of issue.
    let icon: string;
    if (isForeign) {
      icon = !job.enabled ? "✗" : job.lastStatus === "error" ? "!" : "✓";
    } else if (!job.enabled) {
      icon = this.theme.fg("muted", "✗");
    } else if (job.lastStatus === "running") {
      icon = this.theme.fg("warning", "⟳");
    } else if (job.lastStatus === "error") {
      icon = this.theme.fg("error", "!");
    } else {
      icon = this.theme.fg("success", "✓");
    }

    const name = truncate(job.name, NAME_W).padEnd(NAME_W);
    const sched = truncate(
      CronScheduler.describeSchedule(job.type, job.schedule),
      SCHED_W,
    ).padEnd(SCHED_W);
    const prompt = truncate(job.command !== undefined ? `$ ${job.command}` : job.prompt ?? "", PROMPT_W).padEnd(PROMPT_W);
    const tag = !job.session && !isForeign ? this.theme.fg("dim", " [shared]") : "";

    return ` ${indicator} ${icon} ${name}  ${sched}  ${prompt}${tag}`;
  }
}
