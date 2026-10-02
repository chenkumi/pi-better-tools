import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionScheduler } from "./session-scheduler.js";

/** Keep the extension surface intentionally small: Pi owns layout while this reports scheduler state. */
export function updateSchedulerStatus(ctx: ExtensionContext, scheduler: SessionScheduler): void {
  ctx.ui.setStatus("pi-scheduler", scheduler.profileOwnershipActive ? "scheduler: profile override active" : "scheduler: ready");
}
