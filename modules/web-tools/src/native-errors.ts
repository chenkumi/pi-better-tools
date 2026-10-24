/** Shared PROVIDER_UNSUPPORTED text for native search injection: what was unexpected, what happens, how to switch. */
export function unexpectedPayload(provider: string, field: string, value: unknown, expected: 'an array' | 'an object' = 'an array'): Error {
  const received = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  return new Error(`PROVIDER_UNSUPPORTED: unexpected ${provider} ${field} payload (expected ${expected}, got ${received}); native web search is skipped for this request. `
    + 'To search without native injection, ask the user to switch the web search service to brave, exa or deepseek in the web tools configuration and run /reload.');
}
