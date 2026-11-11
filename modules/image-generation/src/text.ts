/** Provider and CLI text is untrusted: strip control and bidi characters, collapse whitespace and bound the length. */
export function clean(value: unknown, max = 300): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).slice(0, max * 4)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
