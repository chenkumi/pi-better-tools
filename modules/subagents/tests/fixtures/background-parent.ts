import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../../extensions/subagent/index.ts";
// A real parent extension with isolated local storage and the same verified CLI.
export default function (pi: ExtensionAPI) {
	const root = process.cwd(), cli = resolve(process.env.PI_SUBAGENTS_TEST_CLI ?? process.argv[1]);
	const launcher = fileURLToPath(new URL("./background-child.mjs", import.meta.url));
	registerSubagent(pi, { debugLog: false, settingsAgentDir: join(root, "config"), sessionRootDir: join(root, "managed"),
		invocation: args => ({ command: process.execPath, args: [launcher, root, cli, ...args] }) });
}
