import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { formatHintLine } from "./frame";
import type { FieldRenderContext } from "./types";

/** Non-search enum/number selection; producers own labels, values and decoding. */
export function createListSubmenu<Value>(
  options: { items: SelectItem[]; selectedIndex: number; defaultIndex: () => number | undefined; decode: (value: string) => Value },
  ctx: FieldRenderContext,
  done: (value?: Value) => void,
): Component {
  const { items, decode } = options;
  const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
  list.setSelectedIndex(options.selectedIndex >= 0 ? options.selectedIndex : 0);
  list.onSelect = item => done(decode(item.value));
  list.onCancel = () => done();
  return {
    render(width: number): string[] {
      const lines = [...list.render(width)];
      lines.push("");
      const hints = [
        { key: "↑↓", label: "select" },
        ...(items.length > 1 ? [{ key: `1-${Math.min(9, items.length)}`, label: "choose" }] : []),
        { key: "enter/space", label: "save" },
        ...(options.defaultIndex() !== undefined ? [{ key: "alt+r", label: "reset" }] : []),
        { key: "esc", label: "cancel" },
      ];
      lines.push(truncateToWidth(`  ${formatHintLine(hints, ctx.theme)}`, width, "…", true));
      return lines;
    },
    invalidate(): void { list.invalidate(); },
    handleInput(data: string): void {
      if (matchesKey(data, "alt+r")) {
        const index = options.defaultIndex();
        if (index !== undefined) {
          if (index >= 0) { list.setSelectedIndex(index); ctx.tui.requestRender(); }
          return;
        }
      }
      if (data === " ") {
        const item = list.getSelectedItem();
        if (item) { done(decode(item.value)); return; }
      }
      const num = parseInt(data, 10);
      if (data.length === 1 && !isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
        const item = items[num - 1];
        if (item) { done(decode(item.value)); return; }
      }
      list.handleInput(data);
      ctx.tui.requestRender();
    },
  };
}
