/** Display markers: custom messages that show what the scheduler did. Command output only ever lives in `details`. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MARKER_TYPE = "scheduled_command";

export interface MarkerDetails {
	jobId: string;
	jobName: string;
	kind: "prompt" | "agent" | "shell" | "monitor";
	phase: "start" | "done" | "error" | "skipped";
	scheduledFor?: string;
	catchUp?: number;
	command?: string;
	shell?: string;
	cwd?: string;
	model?: string;
	exitCode?: number;
	output?: string;
	error?: string;
}

export interface MarkerOptions {
	/** Text the model sees. Empty for display-only markers. */
	content?: string;
	/** Wake the main agent (steer delivery). Off for everything except an agent job with notify. */
	wake?: boolean;
}

export function postMarker(pi: Pick<ExtensionAPI, "sendMessage">, details: MarkerDetails, options: MarkerOptions = {}): void {
	try {
		const content = options.content ?? "";
		pi.sendMessage(
			{ customType: MARKER_TYPE, content: content ? [{ type: "text", text: content }] : [], display: true, details },
			options.wake ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
		);
	} catch {
		// A marker is only a display aid; a session that is going away must not turn that into a failed run.
	}
}
