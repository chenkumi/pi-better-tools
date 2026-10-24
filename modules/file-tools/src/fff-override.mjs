// Entry for @ff-labs/pi-fff that makes `override` the default mode, so FFF owns the
// builtin grep/find names instead of adding ffgrep/fffind. Upstream is not modified:
// the default only applies when the --fff-mode flag, PI_FFF_MODE and <agentDir>/pi-fff.json
// all leave the mode unset, so every explicit user choice keeps its upstream precedence.
// Plain .mjs on purpose: the typechecker must not follow deep imports into the third-party TS sources.
import fffExtension from "@ff-labs/pi-fff/src/index.ts";
import { loadConfig } from "@ff-labs/pi-fff/src/config.ts";
import { guardFffTool } from "./fff-guard.mjs";

function fileMode() {
  try {
    return loadConfig().mode;
  } catch {
    // Invalid config is reported by upstream's own loadConfig; do not mask it here.
    return undefined;
  }
}

export default function fffOverrideDefault(pi) {
  const defaultsToOverride = () =>
    process.env.PI_FFF_MODE === undefined && fileMode() === undefined;
  // Pi's ExtensionAPI is an object of closures, so a prototype-linked view keeps every other member live.
  const view = Object.create(pi);
  view.getFlag = (name) => {
    const value = pi.getFlag(name);
    return value === undefined && name === "fff-mode" && defaultsToOverride() ? "override" : value;
  };
  // Wrap only `execute` of the grep/find/multi_grep tools (see fff-guard.mjs); schemas, names and renderers are untouched.
  view.registerTool = (tool) => pi.registerTool(guardFffTool(tool));
  return fffExtension(view);
}
