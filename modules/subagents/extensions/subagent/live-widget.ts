import { BACKGROUND_WIDGET_KEY, type PanelHost } from "../../../../shared/src/background/index.js";
import type { PanelJob } from "../../../../shared/src/background/index.js";
import { JobsWidgetBinding } from "../../../../shared/src/background/index.js";
export const SUBAGENT_WIDGET_KEY = BACKGROUND_WIDGET_KEY;

/** Owner-bound, event-driven view. Never performs model/provider/tool work. */
export class SubagentJobsWidget extends JobsWidgetBinding<PanelJob> {
  constructor(api?: PanelHost) { super("subagents", rows => rows, api); }
}
