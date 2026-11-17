// Public Pi entry of the merged Subagents extension: the subagent tools and Spinoff. The agent_status / agent_cancel / agent_message
// tools registered by the subagent extension serve subagent jobs and Spinoffs alike, so both load and switch off together.
// Keep guard and bundled-agent paths anchored to the implementation.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagent/index.ts";
import spinoff from "./spinoff/index.ts";

export default function (pi: ExtensionAPI) {
	subagents(pi);
	spinoff(pi);
}
