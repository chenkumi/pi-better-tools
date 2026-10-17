import { describe, expect, it } from "vitest";
import { formatRows } from "../src/output.js";

/** The original quadratic definition: the largest prefix whose pretty-printed `{ rows }` fits in 48 KiB.
 *  Fixture rows contain only values that sanitising leaves unchanged. */
function reference(rows: Array<Record<string, unknown>>): number {
  let kept = 0;
  for (let i = 1; i <= Math.min(rows.length, 200); i++) {
    if (Buffer.byteLength(JSON.stringify({ rows: rows.slice(0, i) }, null, 2), "utf8") > 48 * 1024) break;
    kept = i;
  }
  return kept;
}

describe("formatRows", () => {
  it("keeps the same 48 KiB row prefix without re-serializing every prefix", () => {
    const shapes = [
      (i: number) => ({ id: i, name: "名前".repeat(i % 40), nested: { a: [i, "x"], b: null }, empty: {} }),
      (i: number) => ({ id: i, text: "y".repeat(997), list: [] }),
      () => ({}),
    ];
    for (const shape of shapes) {
      const rows = Array.from({ length: 250 }, (_, i) => shape(i));
      const formatted = formatRows(rows, rows.length);
      expect(formatted.details.returnedRows).toBe(reference(rows));
      expect(formatted.details.truncated).toBe(true);
    }
  });
});
