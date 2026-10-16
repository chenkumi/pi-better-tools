import { BACKGROUND_WIDGET_KEY, type PanelHost } from "../../../shell-tools/src/background-panel.js";
import type { PanelJob } from "../../../shell-tools/src/job-view.js";
import { JobsWidgetBinding } from "../../../shell-tools/src/widget-binding.js";
export const SUBAGENT_WIDGET_KEY = BACKGROUND_WIDGET_KEY;

/** Owner-bound, event-driven view. Never performs model/provider/tool work. */
export class SubagentJobsWidget extends JobsWidgetBinding<PanelJob> {
  constructor(api?: PanelHost) { super("subagents", rows => rows, api); }
}
