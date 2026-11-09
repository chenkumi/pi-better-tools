// The global tool renderer: TUI_DESIGN.md "Tool Call". No background box; collapsed = two rows; expanded = body with a bar.
// Click-to-expand and Ctrl+O are the host's own (every returned component is already wrapped in a click region).
import type { ExtensionAPI, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { callTitle, formatDuration, resultView } from "./summary.ts";

/** Tools whose own renderer shows something richer than text output (live conversations); they keep their content, in the common frame. */
export const OWN_RENDERER_TOOLS: ReadonlySet<string> = new Set(["subagent", "subagent_message", "fork"]);
/** Expanded bodies stop here; the full result stays in the session and in the model context. */
export const MAX_EXPANDED_LINES = 200;
const INDENT = "   ";
const BAR = "▌";
const HINT_EXPAND = "[Click to expand]";
const HINT_COLLAPSE = "[Click to Collapse]";

type Paint = { fg(color: string, text: string): string; bold(text: string): string };
interface Context { isError: boolean; isPartial: boolean; expanded: boolean; durationMs: number | undefined }
type Component = { invalidate(): void; render(width: number): string[]; rows(width: number): string[] };

/** A row must never be wider than the viewport, whatever the content or the width. */
const clamp = (rows: string[], width: number) => rows.map(row => visibleWidth(row) > width ? truncateToWidth(row, Math.max(0, width), "") : row);

/** Shortens `target` so that `prefix + target + suffix` fits; the suffix (for example the timeout) is never cut. */
function fitTitle(prefix: string, target: string, suffix: string, width: number): string {
  const fixed = visibleWidth(prefix) + visibleWidth(suffix);
  const room = Math.max(1, width - fixed);
  return `${prefix}${truncateToWidth(target, room, "…")}${suffix}`;
}

function rowWithHint(left: string, hint: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(hint);
  if (gap < 2) return truncateToWidth(left, width, "…");
  return `${left}${" ".repeat(gap)}${hint}`;
}

function callComponent(toolName: string, args: unknown, theme: Paint, context: Context): Component {
  return {
    invalidate() {},
    render(width: number) { return clamp(this.rows(width), width); },
    rows(width: number) {
      const title = callTitle(toolName, args);
      const dot = theme.fg(context.isError ? "error" : context.isPartial ? "warning" : "success", "●");
      const label = title.label === "$" ? theme.bold(theme.fg("toolTitle", "$")) : theme.bold(theme.fg("toolTitle", title.label));
      const head = `${dot} ${label} `;
      if (!context.expanded) return ["", fitTitle(head, theme.fg("muted", title.target), theme.fg("muted", title.suffix), width)];
      // Expanded: the whole target, wrapped, with the suffix on the last row.
      const wrapped = wrapTextWithAnsi(theme.fg("muted", `${title.target}${title.suffix}`), Math.max(1, width - visibleWidth(head)));
      return ["", ...wrapped.map((row, index) => (index === 0 ? head : " ".repeat(visibleWidth(head))) + row)];
    },
  };
}

function resultComponent(toolName: string, result: unknown, theme: Paint, context: Context): Component {
  const view = resultView(toolName, result, context.isError);
  const took = formatDuration(context.durationMs);
  return {
    invalidate() {},
    render(width: number) { return clamp(this.rows(width), width); },
    rows(width: number) {
      if (context.isPartial) return [`${INDENT}${theme.fg("dim", "running…")}`];
      const color = view.isError ? "error" : "dim";
      if (!context.expanded) {
        const tail = took ? ` · Took ${took}` : "";
        const room = Math.max(8, width - visibleWidth(HINT_EXPAND) - 2 - visibleWidth(INDENT) - visibleWidth(tail));
        return [rowWithHint(`${INDENT}${theme.fg(color, truncateToWidth(view.summary, room, "…"))}${theme.fg("dim", tail)}`, theme.fg("dim", HINT_EXPAND), width)];
      }
      const rows: string[] = [""];
      const shown = view.lines.slice(0, MAX_EXPANDED_LINES);
      const bodyWidth = Math.max(1, width - visibleWidth(INDENT) - 2);
      for (const line of shown) {
        const wrapped = line === "" ? [""] : wrapTextWithAnsi(line, bodyWidth);
        for (const row of wrapped) rows.push(`${INDENT}${theme.fg(view.isError ? "error" : "border", BAR)} ${theme.fg(view.isError ? "error" : "toolOutput", row)}`);
      }
      if (view.lines.length > shown.length) rows.push(`${INDENT}${theme.fg("dim", `… ${view.lines.length - shown.length} more lines`)}`);
      if (!view.lines.length) rows.push(`${INDENT}${theme.fg("dim", view.summary)}`);
      rows.push("", rowWithHint(`${INDENT}${theme.fg("dim", took ? `Took ${took}` : view.isError ? "failed" : "done")}`, theme.fg("dim", HINT_COLLAPSE), width));
      return rows;
    },
  };
}

type Inner = { render(width: number): string[]; invalidate?(): void } | undefined;

/**
 * The common frame around a tool's own components: no background box, the status dot before the first call row, a three-column
 * indent for everything else. The content (live progress, detach hint, markdown) is the tool's own and is not changed.
 */
function ownFrame(inner: Inner, kind: "call" | "result", theme: Paint, context: Context): Component | undefined {
  if (!inner) return undefined;
  return {
    invalidate() { inner.invalidate?.(); },
    render(width: number) { return clamp(this.rows(width), width); },
    rows(width: number) {
      const rows = inner.render(Math.max(1, width - visibleWidth(INDENT)));
      if (!rows.length) return [];
      if (kind === "result") return rows.map(row => INDENT + row);
      const dot = theme.fg(context.isError ? "error" : context.isPartial ? "warning" : "success", "●");
      return ["", ...rows.map((row, index) => (index === 0 ? `${dot}  ` : INDENT) + row)];
    },
  };
}

/**
 * Builds the resolver. `own` tools (live conversation views) keep the content their own renderer (or the remaining resolvers) provide,
 * inside the common frame; every other tool, builtin, project or third-party, gets the full common look.
 */
export function createToolRenderer(own: ReadonlySet<string> = OWN_RENDERER_TOOLS): ToolRendererResolver {
  return (toolName, next): ToolRenderers | undefined => {
    if (own.has(toolName)) {
      const inner = next();
      return {
        renderShell: "self",
        renderCall: (args: unknown, theme: unknown, context: unknown) =>
          ownFrame(inner?.renderCall?.(args as never, theme as never, context as never) as Inner, "call", theme as Paint, context as Context) ?? callComponent(toolName, args, theme as Paint, context as Context),
        renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) =>
          ownFrame(inner?.renderResult?.(result as never, options as never, theme as never, context as never) as Inner, "result", theme as Paint, context as Context) ?? resultComponent(toolName, result, theme as Paint, context as Context),
      } as ToolRenderers;
    }
    return {
      renderShell: "self",
      renderCall: (args: unknown, theme: unknown, context: unknown) => callComponent(toolName, args, theme as Paint, context as Context),
      renderResult: (result: unknown, _options: unknown, theme: unknown, context: unknown) => resultComponent(toolName, result, theme as Paint, context as Context),
    } as ToolRenderers;
  };
}

export function registerToolRenderer(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createToolRenderer());
}
