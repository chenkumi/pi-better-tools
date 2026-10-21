import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { DETACH_HINT, forgetToolRow, isForegroundDetachable, rememberToolRow } from "./manual-detach.js";

export interface DetachHintOptions {
  toolCallId: string;
  theme: Theme;
  /** The row's own redraw handle (`ToolRenderContext.invalidate`). */
  invalidate: () => void;
  /** Set by a call renderer when the result region already renders the hint, so it is not shown twice. */
  skip?: boolean;
  /** Set once the call has finished: the redraw handle is dropped and no hint is drawn. */
  finished?: boolean;
}

/**
 * Appends the detach hint as the last line of a tool row while that call runs foreground work the `Alt+J` shortcut would
 * move to a background job. Only containers are extended: the host rebuilds them on every render, so the line cannot be
 * duplicated, and any other component (for example a plain receipt) keeps the host's own layout untouched.
 */
export function addDetachHint(component: Component, options: DetachHintOptions): Component {
  const { toolCallId, theme, invalidate, skip = false, finished = false } = options;
  if (finished) forgetToolRow(toolCallId);
  else rememberToolRow(toolCallId, invalidate);
  if (skip || finished || !isForegroundDetachable(toolCallId)) return component;
  if (!(component instanceof Container)) return component;
  component.addChild(new Spacer(1));
  component.addChild(new Text(theme.fg("muted", DETACH_HINT), 0, 0));
  return component;
}
