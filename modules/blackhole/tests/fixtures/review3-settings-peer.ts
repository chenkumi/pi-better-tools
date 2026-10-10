import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ConfigManager } from "../../src/pi-base/config-manager.js";
import { getRawSessionConfig, PENDING_SENTINEL } from "../../src/pi-base/config.js";
import { canonicalPersistedSettings } from "../../src/core/pi-owned-settings.js";
const KEY = Symbol.for("pi-blackhole:review3-probe");
export default (pi: ExtensionAPI) => {
  const opts = {
    id: "review3-settings", label: "Review3", configDir: getAgentDir(),
    defaults: { memory: false, compaction: "off", observeAfterTokens: 4000, model: { provider: "default", id: "default" } },
    env: { observeAfterTokens: "PI_REVIEW3_OBSERVE" }, canonicalizePersisted: canonicalPersistedSettings,
    fields: (values: any): any[] => [{ key: "memory", type: "boolean", label: "Memory", value: values.memory }, { key: "compaction", type: "enum", label: "Compaction", value: values.compaction, options: ["off", "manual", "auto"] }, { key: "observeAfterTokens", type: "number", label: "Observe", value: values.observeAfterTokens }, { key: "model", type: "readonly", label: "Model", value: JSON.stringify(values.model) }],
    diagnostics: () => process.env.REVIEW3_SCENARIO === "no-ui-direct" ? ["DIRECT_REVIEW3_WARNING"] : [],
  };
  const make = () => new ConfigManager(opts), cm = make();
  pi.on("session_start", (_event, ctx) => {
    cm.resolveHostSession(cm.layerValues("env", ctx.cwd), ctx, (type, data) => pi.appendEntry(type, data));
    (globalThis as any)[KEY] = { cm, make, ctx, readPending: (sm: any) => getRawSessionConfig("session-config-review3-settings", sm.getCwd(), sm.getSessionId(), PENDING_SENTINEL), append: (type: string, data: unknown) => pi.appendEntry(type, data) };
  });
  pi.registerCommand("review3-reset", { description: "Isolated actual Session Reset probe", handler: async (_args, ctx) => {
    await cm.openSettings(ctx, ctx.cwd, () => {});
  } });
};
