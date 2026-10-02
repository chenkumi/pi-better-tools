import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IndependentRunner } from "./runner.js";
import type { SessionScheduler } from "./session-scheduler.js";

export class AppScheduler {
  private opened = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private role: "stopped" | "host" | "standby" | "child-disabled" | "error" = "stopped";
  private lastError: string | undefined;

  constructor(
    readonly runner: IndependentRunner,
    readonly session: SessionScheduler,
    private readonly options: { child?: boolean; pollMs?: number } = {},
  ) {}

  async start(ctx: ExtensionContext): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    if (this.options.child ?? process.env.PI_SCHEDULER_CHILD === "1") {
      this.role = "child-disabled";
      return;
    }
    try { await this.session.start(ctx); }
    catch (error) { this.record(error); }
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 1000);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    if (!this.opened || this.role === "child-disabled") return;
    if (this.pending) return this.pending;
    this.pending = this.tick().catch((error) => this.record(error)).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async tick(): Promise<void> {
    await this.session.refresh();
    try {
      await this.runner.start();
      this.role = "host";
      await this.runner.poll();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") this.role = "standby";
      else this.record(error);
    }
  }

  private record(error: unknown): void {
    this.role = "error";
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  async stop(): Promise<void> {
    this.opened = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    try { await this.session.shutdown(); }
    finally { await this.runner.stop(); this.role = "stopped"; }
  }

  async status() {
    return {
      role: this.role,
      requiresOpenApp: true,
      missedRunPolicy: "no-backfill",
      lastError: this.lastError,
      sessionError: this.session.lastError,
      independent: await this.runner.status(),
    };
  }
}
