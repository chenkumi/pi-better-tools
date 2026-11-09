import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, sumUsage } from "./usage.js";

/** The speed label is published by GPT Speed through setStatus; the footer places it itself. */
const SPEED_STATUS_KEY = "gpt-speed";
const BAR_CELLS = 12;

/** Nerd Font glyphs used by TUI_DESIGN.md (private-use code points; each is followed by two spaces) and their theme colours. */
const ICON = {
  folder: ["", "accent"], context: ["", "accent"], model: ["", "accent"], thinking: ["", "accent"],
  speed: ["", "accent"], up: ["", "accent"], down: ["", "accent"],
} as const;

/** Every text run is painted `dim` (one grey); only icons (all of them the accent colour, whatever they stand for; the cache-hit bolt included), the `$` sign (accent, like the icons) and the context bar carry colour. */
type Paint = (color: string, text: string) => string;
export interface FooterModel {
  cwd: string; home?: string; branch?: string | null; sessionName?: string;
  modelId?: string; provider?: string; reasoning?: boolean; thinkingLevel?: string;
  contextPercent: number | null; contextWindow: number; contextTokens: number | null; autoCompact: boolean;
  entries: readonly unknown[]; statuses: ReadonlyMap<string, string>; subscription?: boolean;
}

export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return !inside ? cwd : rel === "" ? "~" : `~${sep}${rel}`;
}

const sanitize = (text: string) => stripVTControlCharacters(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

/** Green → yellow → red along the bar. */
const GRADIENT = [[88, 196, 112], [232, 196, 64], [232, 72, 72]] as const;
function gradientRgb(t: number): [number, number, number] {
  const scaled = Math.max(0, Math.min(1, t)) * (GRADIENT.length - 1);
  const index = Math.min(GRADIENT.length - 2, Math.floor(scaled)), local = scaled - index;
  const from = GRADIENT[index]!, to = GRADIENT[index + 1]!;
  return [0, 1, 2].map(channel => Math.round(from[channel]! + (to[channel]! - from[channel]!) * local)) as [number, number, number];
}
const rgb = ([r, g, b]: [number, number, number], text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
/** Without truecolor the three theme colours stand in for the gradient. */
const stepColor = (t: number) => t < 0.55 ? "success" : t < 0.8 ? "warning" : "error";

/** `<icon>  [███░░░░░░░░░] 12.3% 33k/272k (auto)`: filled cells are coloured by their position on the gradient (a full bar sweeps green to red). */
export function contextSegment(model: FooterModel, paint: Paint, truecolor = false): string {
  const percent = model.contextPercent ?? 0;
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(percent / 100 * BAR_CELLS)));
  const cells: string[] = [];
  for (let index = 0; index < BAR_CELLS; index++) {
    const t = index / (BAR_CELLS - 1);
    cells.push(index >= filled ? paint("dim", "░") : truecolor ? rgb(gradientRgb(t), "█") : paint(stepColor(t), "█"));
  }
  const used = model.contextTokens === null ? "?" : formatTokens(model.contextTokens);
  const shown = model.contextPercent === null ? "?" : percent.toFixed(1);
  const textColor = percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
  const text = `${shown}% ${used}/${formatTokens(model.contextWindow)}${model.autoCompact ? " (auto)" : ""}`;
  return `${paint(ICON.context[1], ICON.context[0])}  ${paint("dim", "[")}${cells.join("")}${paint("dim", "]")} ${paint(textColor, text)}`;
}

/** Theme colour per thinking level, the same ones Pi uses for the editor border; an unknown level reads as off, like Pi. */
const THINKING_COLORS: Record<string, string> = {
  off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
};
export const thinkingColor = (level: string) => THINKING_COLORS[level] ?? "thinkingOff";

const withIcon = (kind: keyof typeof ICON, text: string, paint: Paint) => `${paint(ICON[kind][1], ICON[kind][0])}  ${paint("dim", text)}`;

function usageSegments(model: FooterModel, paint: Paint): string[] {
  const totals = sumUsage(model.entries);
  // Up, down and cost are always shown (zero on a fresh session); W and the cache-hit rate only once the provider reports cache use
  // (the cumulative cache-read total is not shown).
  const parts = [withIcon("up", formatTokens(totals.input), paint), withIcon("down", formatTokens(totals.output), paint)];
  if (totals.cacheWrite) parts.push(paint("dim", `W${formatTokens(totals.cacheWrite)}`));
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.cacheHitRate !== undefined) parts.push(`${paint("accent", "\u{1f5f2}")} ${paint("dim", `${totals.cacheHitRate.toFixed(1)}%`)}`);
  parts.push(`${paint("accent", "$")} ${paint("dim", `${totals.cost.toFixed(3)}${model.subscription ? " (sub)" : ""}`)}`);
  return parts;
}

/** Left text, right text, at least two spaces between; the right side yields first. */
function row(left: string, right: string, width: number): string {
  const leftText = visibleWidth(left) > width ? truncateToWidth(left, width, "...") : left;
  const room = width - visibleWidth(leftText) - 2;
  if (room <= 0 || !right) return leftText;
  const rightText = truncateToWidth(right, room, "");
  return `${leftText}${" ".repeat(width - visibleWidth(leftText) - visibleWidth(rightText))}${rightText}`;
}

export function renderFooter(model: FooterModel, width: number, paint: Paint, truecolor = false): string[] {
  const inner = Math.max(1, width);
  // `cwd · branch`: the branch name is the theme's main (accent) colour, the rest the common grey.
  let location = paint("dim", formatCwd(model.cwd, model.home));
  if (model.branch) location += `${paint("dim", " · ")}${paint("accent", model.branch)}`;
  if (model.sessionName) location += paint("dim", ` • ${model.sessionName}`);
  const thinking = model.reasoning ? (model.thinkingLevel || "off") : undefined;
  const modelText = [model.provider, model.modelId ?? "no-model"].filter(Boolean).join(" · ");
  const left2 = `${paint(ICON.model[1], ICON.model[0])}  ${paint("dim", modelText)}${thinking ? `${paint("dim", " · ")}${paint(ICON.thinking[1], ICON.thinking[0])}  ${paint(thinkingColor(thinking), thinking)}` : ""}`;
  // GPT Speed's own label reads "Speed: Normal"; the footer shows just the mode, in the same grey as the rest.
  const speed = model.statuses.get(SPEED_STATUS_KEY);
  const right2 = [speed ? withIcon("speed", sanitize(speed).replace("Speed: ", ""), paint) : "", ...usageSegments(model, paint)].filter(Boolean).join(paint("dim", " | "));
  const lines = [
    row(`${paint(ICON.folder[1], ICON.folder[0])}  ${location}`, contextSegment(model, paint, truecolor), inner),
    row(left2, right2, inner),
  ];
  const others = [...model.statuses].filter(([key]) => key !== SPEED_STATUS_KEY).sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => sanitize(text)).filter(Boolean);
  if (others.length) lines.push(truncateToWidth(paint("dim", others.join(" ")), inner, paint("dim", "...")));
  return lines;
}

export function footerComponent(read: () => FooterModel, paint: Paint, truecolor = false): Component {
  return { invalidate() {}, render: width => renderFooter(read(), width, paint, truecolor) };
}
