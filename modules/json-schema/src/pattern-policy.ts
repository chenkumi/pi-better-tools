/**
 * Pi validates tool parameters synchronously BEFORE extension.execute(). Workers
 * cannot protect that boundary. Accept a deliberately small, linear subset;
 * complex patterns must be expressed outside structured-output tool schemas.
 */
export function assertSafeSchemaPattern(source: unknown, path: string): void {
  if (typeof source !== "string" || source.length > 200) throw new Error(`pattern at ${path} must be a string of at most 200 characters`);
  let inClass = false;
  let quantifiers = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      const escaped = source[++i];
      // Unknown escapes and backreferences are not part of the proven subset.
      if (!escaped || (!inClass && !"dDsSwWbB\\^$.*+?()[]{}|-/".includes(escaped))) throw new Error(`unsafe pattern at ${path}: unsupported escape`);
      continue;
    }
    if (inClass) { if (char === "]") inClass = false; continue; }
    if (char === "[") { inClass = true; continue; }
    if ("()|{}".includes(char)) throw new Error(`unsafe pattern at ${path}: groups, alternatives and counted repetitions are unsupported`);
    if ("*+?".includes(char)) {
      // Anchoring prevents restarting an unbounded scan at each input position.
      if (source[0] !== "^" || ++quantifiers > 1) throw new Error(`unsafe pattern at ${path}: require ^ anchoring and at most one quantifier`);
    }
  }
  if (inClass) throw new Error(`invalid pattern at ${path}: unfinished character class`);
  try { new RegExp(source); } catch (error) { throw new Error(`invalid pattern at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
