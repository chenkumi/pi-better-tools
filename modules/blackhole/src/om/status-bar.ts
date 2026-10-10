/**
 * Footer status bar — token gauges plus live worker events, drawn with
 * ctx.ui.setStatus("blackhole", ...).
 *
 * Gauges: O = transcript tokens since the last observer run (fills at
 * observeAfterTokens), P = observation pool fill (fills at
 * observationsPoolMaxTokens). X shows public context usage versus context
 * capacity; it does not infer Pi's native trigger budget. O/P/X turn warning-colored at
 * or above 100%. O and P are omitted while `memory === false`: the
 * consolidation pipeline hard-returns before any observer runs, so a filling
 * gauge would imply a pass that is never due. They return on the next render
 * when memory is re-enabled (/blackhole om-on).
 *
 * Worker events sit beside the gauges: a spinner while a stage runs, then
 * `✓ +N` for 5 seconds. A stage that skipped itself (nothing due) never
 * appears. Compactions show `✓ [compact] <reason>`.
 *
 * Worker state comes from the runtime, not from inference: the bar reads
 * runtime.consolidationPhase and runtime.consolidationInFlight on every
 * tick, so the consolidation pipeline needs no instrumentation.
 *
 * Ported from the standalone blackhole-status.ts footer extension. Its
 * config-file read, preset-curve copy, token-estimation mirror, and
 * threshold-inference blocks are all replaced by in-repo sources of truth.
 * All three progress bars use four cells to keep the footer compact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime, ConsolidationPhase } from "./runtime.js";
import {
  foldLedger,
  observationPoolTokens,
  rawTokensSinceObservationCoverage,
  type Entry,
} from "./ledger/index.js";

const STATUS_KEY = "blackhole";
// Match pi's own working spinner (pi-tui Loader): 10 braille frames at 80 ms,
// so the footer never shows a second, out-of-sync spinner style.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const SETTLE_MS = 5000;
const GAUGE_CELLS = 4;
type ThemeShim = {
  fg: (style: string, text: string) => string;
  bg?: (style: string, text: string) => string;
};
const EMPTY_THEME: ThemeShim = { fg: (_style, text) => text };

type WorkerType = ConsolidationPhase | "compact";
type WorkerState = { kind: "running" } | { kind: "done"; delta?: number; note?: string };

interface WorkerEntry {
  type: WorkerType;
  state: WorkerState;
  startCounts?: Counts;
  settleTimer?: ReturnType<typeof setTimeout>;
}

interface Counts {
  observations: number;
  reflections: number;
  dropped: number;
}

interface Gauges {
  obsSince: number;
  pool: number;
  contextTokens: number;
  contextCapacity: number;
}

interface StatusBarUi {
  setStatus?: (key: string, text: string | undefined) => void;
  theme?: ThemeShim;
}

/** Register the footer status bar. Gated by config.statusBar at render time. */
export function registerStatusBar(pi: ExtensionAPI, runtime: Runtime): void {
  let ui: StatusBarUi | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let statusWritten = false;
  let lastRendered: string | undefined;
  const workers: WorkerEntry[] = [];
  let gauges: Gauges = { obsSince: 0, pool: 0, contextTokens: 0, contextCapacity: 0 };
  // Change detection so the fold only re-runs when something actually moved.
  let lastBranchLen = 0;
  let lastTailId: string | undefined;
  let lastInFlight = false;
  let lastPhase: ConsolidationPhase | undefined;
  // O/P are only measured while memory is on, so a flip of that flag has to
  // count as a change too (set in recompute; session_start always runs first).
  let lastMemoryOn = true;

  function theme(): ThemeShim {
    return ui?.theme ?? EMPTY_THEME;
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  /** Four-cell bar with half-cell fill precision and a dim track. */
  function gaugeBar(t: ThemeShim, value: number, max: number): string {
    const frac = max > 0 ? value / max : 0;
    // Two fill steps per terminal cell: the odd step uses U+258C LEFT HALF BLOCK.
    const units = Math.min(GAUGE_CELLS * 2, Math.round(Math.min(1.2, frac) * GAUGE_CELLS * 2));
    const fullCells = Math.floor(units / 2);
    const halfCell = units % 2 === 1 ? (t.bg ? t.bg("toolPendingBg", t.fg(colorForFraction(frac), "▌")) : "▌") : "";
    // Fill tiers encode load: success below 80%, warning near capacity, error
    // at/above 100%; the unfilled track stays dim gray.
    const color = colorForFraction(frac);
    const emptyCells = GAUGE_CELLS - fullCells - (units % 2 === 1 ? 1 : 0);
    return t.fg(color, "█".repeat(fullCells)) + halfCell + t.fg("dim", "░".repeat(emptyCells));
  }

  function colorForFraction(frac: number): string {
    if (frac >= 1) return "error";       // 100%+
    if (frac >= 0.75) return "warning"; // 75–99%
    if (frac >= 0.5) return "accent";   // 50–74%
    if (frac >= 0.25) return "success"; // 25–49%
    return "muted";                     // below 25%
  }

  function clearStatus(): void {
    if (ui?.setStatus && statusWritten) ui.setStatus(STATUS_KEY, undefined);
    statusWritten = false;
    lastRendered = undefined;
  }

  /**
   * Compose the footer and write it to ctx.ui.setStatus. Every render-time
   * gate lives here so a config change (om-on/om-off, /blackhole settings)
   * is picked up on the next tick without re-registering.
   */
  function render(): void {
    if (!ui) return; // no UI or ctx.hasUI === false — nothing to draw into
    if (runtime.config.statusBar === false) {
      clearStatus();
      return;
    }
    if (!ui.setStatus) return;
    const t = theme();
    const cfg = runtime.config;
    const segments: string[] = [];
    // O and P describe observational-memory work the consolidation pipeline
    // never launches while memory === false (it hard-returns first), so a
    // filling gauge would promise a note-taking pass that cannot run.
    if (cfg.memory !== false) {
      segments.push(`${t.fg("muted", "O")} ${gaugeBar(t, gauges.obsSince, cfg.observeAfterTokens)}`);
      segments.push(
        `${t.fg("muted", "P")} ${gaugeBar(t, gauges.pool, cfg.observationsPoolMaxTokens)}`,
      );
    }
    segments.push(`${t.fg("muted", "X")} ${gauges.contextCapacity > 0 ? gaugeBar(t, gauges.contextTokens, gauges.contextCapacity) : t.fg("dim", "(unknown)")}`);
    let s = `${t.fg("success", "bh")} ${segments.join("  ")}`;
    const parts: string[] = [];
    for (const w of workers) {
      if (w.state.kind === "running") {
        parts.push(`${t.fg("accent", SPINNER_FRAMES[frame])} ${t.fg("accent", `[${w.type}]`)}`);
      } else {
        const delta =
          w.state.delta && w.state.delta > 0 ? ` ${t.fg("success", `+${w.state.delta}`)}` : "";
        const note = w.state.note ? ` ${t.fg("muted", w.state.note)}` : "";
        parts.push(`${t.fg("success", "✓")} ${t.fg("muted", `[${w.type}]`)}${delta}${note}`);
      }
    }
    if (parts.length > 0) s += `  ${parts.join(" ")}`;
    if (s === lastRendered) return;
    lastRendered = s;
    ui.setStatus(STATUS_KEY, s);
    statusWritten = true;
  }

  // ── worker lifecycle ───────────────────────────────────────────────────────

  function runningWorker(): WorkerEntry | undefined {
    return workers.find((w) => w.state.kind === "running");
  }

  function removeWorker(w: WorkerEntry): void {
    if (w.settleTimer) clearTimeout(w.settleTimer);
    w.settleTimer = undefined;
    const i = workers.indexOf(w);
    if (i !== -1) workers.splice(i, 1);
  }

  function armSettle(w: WorkerEntry): void {
    w.settleTimer = setTimeout(() => {
      removeWorker(w);
      render();
    }, SETTLE_MS);
    w.settleTimer.unref?.();
  }

  /** Close a running stage. A stage that added nothing (skipped itself) is
   *  removed silently; one that added entries shows `✓ +N` for SETTLE_MS. */
  function finishWorker(w: WorkerEntry, counts: Counts): void {
    const field =
      w.type === "observer" ? "observations" : w.type === "reflector" ? "reflections" : "dropped";
    const delta = w.startCounts ? Math.max(0, counts[field] - w.startCounts[field]) : 0;
    if (delta <= 0) {
      removeWorker(w);
      return;
    }
    w.state = { kind: "done", delta };
    armSettle(w);
  }

  function syncWorkers(counts: Counts): void {
    const running = runningWorker();
    if (runtime.consolidationInFlight) {
      // Covers pre-phase launch: launchConsolidationTask sets inFlight before
      // the pipeline names its first stage. The tick picks the phase up.
      startSpinner();
      const phase = runtime.consolidationPhase;
      if (phase && (!running || running.type !== phase)) {
        if (running) finishWorker(running, counts);
        workers.push({ type: phase, state: { kind: "running" }, startCounts: counts });
      }
    } else if (running) {
      // Pipeline finished — settle the stage it was on.
      finishWorker(running, counts);
    }
  }

  function startSpinner(): void {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      tick();
      // Keep ticking while the pipeline runs with no phase yet, so the tick
      // can pick up the first stage.
      if (!runningWorker() && !runtime.consolidationInFlight) stopSpinner();
    }, SPINNER_INTERVAL_MS);
    spinnerTimer.unref?.();
  }

  function stopSpinner(): void {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  // Minimal structural view of the handler ctx the bar needs. SAFETY: every
  // real Pi handler ctx carries sessionManager.getBranch; the shape only
  // widens what the handlers already expose, never narrows a missing field.
  interface BranchCtx {
    getContextUsage?: () => unknown;
    sessionManager?: { getBranch?: () => Entry[] };
  }

  // ── ledger reads ───────────────────────────────────────────────────────────

  function branchOf(ctx: BranchCtx | undefined): Entry[] {
    return ctx?.sessionManager?.getBranch?.() ?? [];
  }

  function contextGauge(ctx: BranchCtx): Pick<Gauges, "contextTokens" | "contextCapacity"> {
    try {
      const usage = ctx.getContextUsage?.() as { tokens?: unknown; contextWindow?: unknown } | undefined;
      if (typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 &&
          typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
        return { contextTokens: usage.tokens, contextCapacity: usage.contextWindow };
      }
    } catch { /* A stale/failed public lookup cannot provide a meaningful gauge. */ }
    return { contextTokens: 0, contextCapacity: 0 };
  }

  function recompute(ctx: BranchCtx): void {
    let entries: Entry[];
    try {
      entries = branchOf(ctx);
    } catch {
      // Stale extension context (session replaced) — keep the last render.
      return;
    }
    lastBranchLen = entries.length;
    lastTailId = entries[entries.length - 1]?.id;
    lastInFlight = runtime.consolidationInFlight;
    lastPhase = runtime.consolidationPhase;
    const memoryOn = runtime.config.memory !== false;
    lastMemoryOn = memoryOn;
    // foldLedger also feeds syncWorkers (worker deltas), so it always runs;
    // the two O/P-only scans are skipped while memory is off, since nothing
    // can read them until the next render where the gauges reappear.
    const folded = foldLedger(entries);
    gauges = {
      obsSince: memoryOn ? rawTokensSinceObservationCoverage(entries) : 0,
      // Live active pool only — the P gauge deliberately omits manual-mode
      // pending batches (the dropper trigger includes them); see issue #120.
      pool: memoryOn ? observationPoolTokens(entries).tokens : 0,
      // X measures public current usage against public context capacity, not an
      // inferred native compaction trigger/reserve threshold.
      ...contextGauge(ctx),
    };
    syncWorkers({
      observations: folded.observations.length,
      reflections: folded.reflections.length,
      dropped: folded.droppedObservationIds.size,
    });
    render();
  }

  /** Spinner tick: re-read the ledger only when branch or runtime state moved. */
  const IDLE_POLL_MS = 1_000;
  let idlePollTimer: ReturnType<typeof setInterval> | undefined;

  function tick(): void {
    if (
      lastCtx &&
      runtime.consolidationInFlight === lastInFlight &&
      runtime.consolidationPhase === lastPhase &&
      // A memory flip changes which gauges are measured, so it forces a
      // recompute instead of a bare render (stale zeros otherwise).
      (runtime.config.memory !== false) === lastMemoryOn
    ) {
      try {
        const entries = branchOf(lastCtx);
        const tail = entries[entries.length - 1]?.id;
        if (entries.length === lastBranchLen && tail === lastTailId) {
          render();
          return;
        }
      } catch {
        render();
        return;
      }
    }
    if (lastCtx) recompute(lastCtx);
    else render();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  let lastCtx: BranchCtx | undefined;

  function clearWorkers(): void {
    stopSpinner();
    for (const w of workers) if (w.settleTimer) clearTimeout(w.settleTimer);
    workers.length = 0;
  }

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.hasUI !== false ? (ctx.ui as StatusBarUi | undefined) : undefined;
    lastCtx = ctx as BranchCtx;
    clearWorkers();
    if (!ui) return;
    recompute(ctx as BranchCtx);
    // The pipeline can launch after this module's event handlers ran (handler
    // order inside one event is not a guarantee we own), and an idle session
    // emits no events for minutes. Poll runtime state independently of events
    // so no run is missed. tick() is cheap when nothing moved.
    if (!idlePollTimer) {
      idlePollTimer = setInterval(tick, IDLE_POLL_MS);
      idlePollTimer.unref?.();
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ui) return;
    lastCtx = ctx as BranchCtx;
    recompute(ctx as BranchCtx);
  });

  // The consolidation pipeline launches on agent_start/turn_end, so those are
  // where a run becomes observable. Without these handlers the spinner can
  // only ever start at agent_end, by which time the pipeline is usually done.
  pi.on("agent_start", (_event, ctx) => {
    if (!ui) return;
    lastCtx = ctx as BranchCtx;
    recompute(ctx as BranchCtx);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!ui) return;
    lastCtx = ctx as BranchCtx;
    recompute(ctx as BranchCtx);
  });

  pi.on("session_compact", (event, ctx) => {
    if (!ui) return;
    lastCtx = ctx as BranchCtx;
    const w: WorkerEntry = { type: "compact", state: { kind: "done", note: String(event.reason) } };
    workers.push(w);
    armSettle(w);
    recompute(ctx as BranchCtx);
  });

  pi.on("session_shutdown", () => {
    clearWorkers();
    if (idlePollTimer) clearInterval(idlePollTimer);
    idlePollTimer = undefined;
    clearStatus();
    ui = undefined;
    lastCtx = undefined;
  });

  // The idle poller starts in session_start and stops in session_shutdown,
  // so it never runs outside a live session.
}
