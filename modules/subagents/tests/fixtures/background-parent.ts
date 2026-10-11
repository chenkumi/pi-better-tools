import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../../extensions/subagent/index.ts";
// A real parent extension with isolated local storage and the same verified CLI.
export default function (pi: ExtensionAPI) {
	const root = process.cwd(), cli = resolve(process.env.PI_SUBAGENTS_TEST_CLI ?? process.argv[1]);
	const launcher = fileURLToPath(new URL("./background-child.mjs", import.meta.url));
	registerSubagent({ ...pi, sendMessage(message, options) {
		pi.sendMessage(message, options);
		const details = message.details as any;
		if (details?.kind === "task_result") {
			const marker = join(root, "parent-result-submitted.json");
			writeFileSync(`${marker}.tmp`, JSON.stringify({ options, status: details.status, sessionId: details.tasks[0].subagentSessionId }));
			// Publish only after close; the other process must never read a partial JSON marker.
			renameSync(`${marker}.tmp`, marker);
		}
	} }, { debugLog: false, settingsAgentDir: join(root, "config"), sessionRootDir: join(root, "managed"),
		invocation: args => ({ command: process.execPath, args: [launcher, root, cli, ...args] }) });
	pi.registerTool({ name: "parent_gate", label: "Parent gate", description: "Offline parent tool barrier", parameters: Type.Object({}), defaultActive: false,
		async execute(_id, _args, signal) {
			await new Promise<void>((done, reject) => {
				let finished = false;
				const finish = (error?: Error) => { if (finished) return; finished = true; observer.close(); signal?.removeEventListener("abort", abort); error ? reject(error) : done(); };
				const abort = () => finish(new Error("Parent gate aborted"));
				const release = join(root, "parent-release");
				const observer = watch(root, () => { if (existsSync(release)) finish(); });
				observer.on("error", finish);
				signal?.addEventListener("abort", abort, { once: true });
				writeFileSync(join(root, "parent-gate-ready"), "ready");
				if (existsSync(release)) finish(); else if (signal?.aborted) abort();
			});
			return { content: [{ type: "text", text: "Parent gate released" }], details: undefined };
		} });
}
