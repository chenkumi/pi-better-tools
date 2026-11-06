import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PanelEditor } from "./editor.js";
import { footerComponent, type FooterModel } from "./footer.js";

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

/** Replaces the host footer and the editor frame. Loading registers hooks only; settings are never written. */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PanelEditor(tui, theme, keybindings));
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
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
