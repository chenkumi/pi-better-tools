/** Find a JSON document in free-form assistant text: the whole text, a fenced block, or the first balanced {...} / [...]. */

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** End index (exclusive) of the balanced JSON value that starts at `start`, honouring strings and escapes. */
function balancedEnd(text: string, start: number, limit = text.length): number | undefined {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let index = start; index < limit; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return index + 1;
  }
  return undefined;
}

/** Bounds on the brace scan so huge unbalanced text cannot cost O(n^2). */
export const MAX_SCAN_ATTEMPTS = 64;
export const MAX_SCAN_LENGTH = 1_000_000;

export function extractJson(text: string): { value: unknown } | undefined {
  const whole = tryParse(text.trim());
  if (whole) return whole;
  for (const block of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
    const parsed = tryParse(block[1].trim());
    if (parsed) return parsed;
  }
  let attempts = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    if (++attempts > MAX_SCAN_ATTEMPTS) break;
    const end = balancedEnd(text, index, Math.min(text.length, index + MAX_SCAN_LENGTH));
    if (end === undefined) continue;
    const parsed = tryParse(text.slice(index, end));
    if (parsed) return parsed;
  }
  return undefined;
}
