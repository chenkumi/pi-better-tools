import { CustomEditor } from "@earendil-works/pi-coding-agent";

export const PROMPT = "❯ ";
const PADDING = PROMPT.length;
type EditorArgs = ConstructorParameters<typeof CustomEditor>;

/**
 * The host editor with a prompt glyph (plain text colour, white) on its first text row and a border in the theme's main (accent) colour.
 * Scroll indicators, autocomplete, cursor drawing, the hardware-cursor marker and mouse handling are all inherited:
 * this class never touches cursor style.
 */
export class PanelEditor extends CustomEditor {
  constructor(tui: EditorArgs[0], theme: EditorArgs[1], keybindings: EditorArgs[2], options: EditorArgs[3] = {}, accent?: (text: string) => string, private readonly promptPaint?: (text: string) => string) {
    super(tui, theme, keybindings, { ...options, paddingX: Math.max(options?.paddingX ?? 0, PADDING) });
    // The host paints the border by thinking level (and a dedicated colour in `!` bash mode) by assigning `borderColor` after every
    // change. Keep what it assigns, but draw with the accent colour unless the text is a bash command, so that mode stays visible.
    let hostColor = this.borderColor;
    Object.defineProperty(this, "borderColor", {
      configurable: true, enumerable: true,
      get: () => (accent && !this.getText().startsWith("!") ? accent : hostColor),
      set: (value: (text: string) => string) => { hostColor = value; },
    });
  }
  /** The host re-applies the user's `editorPaddingX` after creating the editor; the prompt glyph needs at least its own width. */
  override setPaddingX(padding: number): void {
    super.setPaddingX(Math.max(padding, PADDING));
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    // Line 0 is the top border; line 1 is the first text row and starts with the left padding.
    const first = lines[1];
    if (first !== undefined && first.startsWith(" ".repeat(PADDING))) lines[1] = `${(this.promptPaint ?? this.borderColor)(PROMPT)}${first.slice(PADDING)}`;
    return lines;
  }
}
