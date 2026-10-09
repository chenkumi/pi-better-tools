// Run the unmodified root module group with uniquely scoped evidence paths.
// Only evidence destinations/import resolution change; tasks and assertions do not.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { transformModuleRunner } from "./child-shell-runner-transform.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const module = process.argv[2];
const suffix = process.argv[3] ?? "";
if (!/^[a-z0-9-]*$/.test(suffix)) throw new Error("Invalid evidence suffix");
if (!["shell-tools", "subagents"].includes(module)) throw new Error("Expected shell-tools or subagents");
const evidenceName = process.argv[4] ?? `child-shell-${module}${suffix ? `-${suffix}` : ""}`;
if (!/^child-shell-[a-z0-9-]+$/.test(evidenceName)) throw new Error("Invalid isolated evidence directory");
const runner = path.join(root, "scripts/run-checks.mjs");
let source = await readFile(runner, "utf8");
source = transformModuleRunner(source, {
  root, processImportURL: pathToFileURL(path.join(root, "modules/file-tools/scripts/test-process.mjs")).href,
  tsxURL: import.meta.resolve("tsx"), piURL: import.meta.resolve("@earendil-works/pi-coding-agent"),
  evidenceRelative: `plan/evidence/${evidenceName}`,
});
process.argv = [process.execPath, runner, "module", module];
console.log(`Starting original module group ${module} with child-shell evidence isolation...`);
source += "\n//# sourceURL=child-shell-isolated-module-runner.mjs\n";
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
