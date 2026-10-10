/**
 * Project-trust admission shared by the extension entry, scheduler and child sessions.
 *
 * Pi 1.1 contexts always expose `isProjectTrusted()`. Anything else (a missing method, a thrown error from a
 * stale context, a non-true result) fails closed: project schedules never start on an unknown trust state.
 */
export function isProjectTrusted(ctx: unknown): boolean {
  const probe = (ctx as { isProjectTrusted?: () => boolean } | undefined)?.isProjectTrusted;
  if (typeof probe !== "function") return false;
  try {
    return probe.call(ctx) === true;
  } catch {
    return false;
  }
}
