// Terminal cell widths for the PTY screen copy.
//
// xterm.js (headless) defaults to Unicode 6 widths, where emoji are one cell wide. Windows Terminal, ConPTY and Pi's own TUI
// layout treat emoji as two cells. With the default table every row that contains an emoji drifts by one cell per glyph, so
// the emulator is given the table below. Ported from the owner's pi-mux project (src/width.mjs), which found and verified
// the same mismatch: CJK and full-width forms are 2, Emoji_Presentation is 2, ZWJ sequences, skin tones, flags and VS16
// join into one two-cell glyph, combining marks are 0.

const ZWJ = 0x200d, VS16 = 0xfe0f, VS15 = 0xfe0e;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cd5], [0x1b000, 0x1b2ff], [0x20000, 0x3fffd],
];
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const WIDE_EXTRA = new Set([0x3000, 0x2329, 0x232a]);

const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isEmojiModifier = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isTagChar = (cp: number) => cp >= 0xe0020 && cp <= 0xe007f;

/** Cell width (0, 1 or 2) of one code point, ignoring context. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (isRegionalIndicator(cp)) return 2;
  if (isEmojiModifier(cp)) return 2; // alone it is a coloured square; after a base it is joined (see charProperties)
  const ch = String.fromCodePoint(cp);
  if (cp === ZWJ || cp === VS16 || cp === VS15 || isTagChar(cp) || ZERO_WIDTH.test(ch)) return 0;
  if (WIDE_EXTRA.has(cp)) return 2;
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  if (cp >= 0x2190 && EMOJI_PRESENTATION.test(ch)) return 2;
  return 1;
}

// Context state carried in the "charKind" bits of xterm's property value (value >> 3).
const AFTER_ZWJ = 1, AFTER_RI = 2;
const props = (state: number, width: number, join: boolean) => ((state & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0);

/** xterm.js IUnicodeVersionProvider; register with `term.unicode.register(provider); term.unicode.activeVersion = provider.version`. */
export const terminalUnicode = {
  version: "pi-better-tools",
  wcwidth: codePointWidth,
  charProperties(cp: number, preceding: number): number {
    const prevState = preceding >> 3, prevWidth = (preceding >> 1) & 3;
    let width: number = codePointWidth(cp), join = false, state = 0;
    if (prevWidth > 0) {
      if (cp === ZWJ) { join = true; state = AFTER_ZWJ; }
      else if (cp === VS16) { join = true; width = 2; } // text symbol + VS16 is drawn as an emoji, two cells
      else if (width === 0) join = true;
      else if (prevState & AFTER_ZWJ && width === 2) join = true; // the part after a ZWJ joins the sequence
      else if (isEmojiModifier(cp)) join = true;
      else if (isRegionalIndicator(cp)) {
        if (prevState & AFTER_RI) join = true; // second half of a flag
      }
    }
    if (isRegionalIndicator(cp) && !join) state |= AFTER_RI;
    if (join) width = Math.max(prevWidth, cp === VS16 ? 2 : 0) || prevWidth;
    return props(state, width, join);
  },
};

/** Width of a string as the emulator lays it out. */
export function stringWidth(text: string): number {
  let total = 0, prev = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const p = terminalUnicode.charProperties(cp, prev);
    if (!(p & 1)) total += (p >> 1) & 3;
    else if (cp === VS16 && ((prev >> 1) & 3) === 1) total += 1;
    prev = p;
  }
  return total;
}
