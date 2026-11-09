import { BACKGROUND_WIDGET_KEY, type PanelHost } from "../../../../shared/src/background/index.ts";
import type { PanelJob } from "../../../../shared/src/background/index.ts";
import { JobsWidgetBinding } from "../../../../shared/src/background/index.ts";
export const SUBAGENT_WIDGET_KEY = BACKGROUND_WIDGET_KEY;

/** Owner-bound, event-driven view. Never performs model/provider/tool work. */
export class SubagentJobsWidget extends JobsWidgetBinding<PanelJob> {
  constructor(api?: PanelHost) { super("subagents", rows => rows, api); }
}
