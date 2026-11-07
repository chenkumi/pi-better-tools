/** Project schedules and project settings are only read for a trusted project; anything uncertain counts as untrusted. */
export function isProjectTrusted(ctx: unknown): boolean {
	const probe = (ctx as { isProjectTrusted?: () => boolean } | undefined)?.isProjectTrusted;
	if (typeof probe !== "function") return false;
	try { return probe.call(ctx) === true; } catch { return false; }
}
