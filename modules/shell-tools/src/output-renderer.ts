import { keyHint, type createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

type ResultRenderer = NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]>;
const PREVIEW_ROWS = 5;

/** Decorate host-produced output only; warnings, sanitization and clocks stay with Pi 1.4.0. */
export function renderShellOutput(
  renderResult: ResultRenderer,
  ...[result, options, theme, context]: Parameters<ResultRenderer>
): ReturnType<ResultRenderer> {
  // The host's collapsed layout identifies output structurally (Spacer + preview),
  // including image fallbacks and sanitized/empty output, without interpreting stdout.
  const component = renderResult(result, { ...options, expanded: false }, theme, context);
  if (!(component instanceof Container) || !(component.children[0] instanceof Spacer)) return component;
  // Ask the host for its sanitized output Text, leaving warnings and timing intact.
  // Both passes share the same clock state and reuse the same Container.
  renderResult(result, { ...options, expanded: true }, theme, { ...context, lastComponent: component });
  const output = component.children[0];
  if (!(output instanceof Text)) return component;
  const decorated: Component = {
    invalidate() { output.invalidate(); },
    render(width) {
      if (width <= 0) return [];
      // Reserve the rail before wrapping. The first host row is a layout spacer.
      const rows = output.render(Math.max(1, width - 1)).slice(1);
      const hidden = options.expanded ? 0 : Math.max(0, rows.length - PREVIEW_ROWS);
      const marked = rows.slice(hidden).map(row => truncateToWidth(theme.fg("muted", "▌") + row, width, ""));
      const hint = hidden > 0
        ? theme.fg("muted", `${hidden} earlier lines, `) + keyHint("app.tools.expand", "to expand")
        : undefined;
      return ["", ...marked, ...(hint ? ["", truncateToWidth(hint, width, "…")] : [])];
    },
  };
  component.children[0] = decorated;
  return component;
}
