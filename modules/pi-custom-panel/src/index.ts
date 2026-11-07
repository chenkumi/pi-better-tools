import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeBottomPanel } from "../../../shared/src/bottom-panel/index.js";
import { PanelEditor } from "./editor.js";
import { footerComponent, type FooterModel } from "./footer.js";
import { registerToolRenderer } from "./tool-render/renderer.js";

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

/** Replaces the host footer and the editor frame and gives every tool call the common look. Loading registers hooks only; settings are never written. */
export default function (pi: ExtensionAPI): void {
  registerToolRenderer(pi);
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    // The accent colour is read from the live theme on every draw, so `/theme:<id>` changes it at once.
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PanelEditor(tui, theme, keybindings, {}, text => ctx.ui.theme.fg("accent", text), text => ctx.ui.theme.fg("text", text)));
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const read = (): FooterModel => {
        const usage = ctx.getContextUsage();
        const model = ctx.model;
        let autoCompact = true;
        try { autoCompact = record(record(pi.getSettings()).compaction).enabled !== false; } catch { /* keep the default */ }
        return {
          cwd: ctx.sessionManager.getCwd(), home: process.env.HOME || process.env.USERPROFILE, branch: footerData.getGitBranch(),
          sessionName: ctx.sessionManager.getSessionName(), modelId: model?.id, provider: model?.provider,
          reasoning: model?.reasoning, thinkingLevel: pi.getThinkingLevel(),
          contextPercent: usage?.percent ?? null, contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0, contextTokens: usage?.tokens ?? null,
          autoCompact, entries: ctx.sessionManager.getEntries(), statuses: footerData.getExtensionStatuses(),
        };
      };
      const component = footerComponent(read, (color, text) => theme.fg(color as never, text), theme.getColorMode() === "truecolor");
      return { ...component, dispose: unsubscribe };
    });
  });
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    // A bottom panel left open across /reload or a session switch would keep the registry busy for good: the host drops its widget
    // and keyboard listener without telling the panel.
    closeBottomPanel();
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
