/**
 * A tool result whose text, `details` and `structuredContent` are one JSON-clean value: the model reads the text,
 * UI and tests read `details`, and a codemode script resolves to `structuredContent` (when the tool declares an `outputSchema`).
 * `isError: true` marks a failure the tool reports in-band instead of throwing.
 */
export function jsonResult(value: unknown, isError = false) {
  const data = JSON.parse(JSON.stringify(value));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    details: data,
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}
