/** Prompt job runner: a display marker, then the prompt joins the current conversation as a queued user message. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunHandle, RunInfo } from "./engine.ts";
import { postMarker } from "./markers.ts";
import type { Job } from "./types.ts";

export function runPromptJob(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, job: Extract<Job, { kind: "prompt" }>, info: RunInfo): RunHandle {
	try {
		postMarker(pi, { jobId: job.id, jobName: job.name, kind: "prompt", phase: "start", scheduledFor: info.scheduledFor, ...(info.missed !== undefined ? { catchUp: info.missed } : {}) });
		pi.sendUserMessage(job.prompt, { deliverAs: "followUp" });
		return { started: Promise.resolve(true), done: Promise.resolve({ status: "success" }) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { started: Promise.resolve(false), done: Promise.resolve({ status: "error", error: message }) };
	}
}
