/** Private, explicit managed-child handshake shared by Shell and the startup guard.
 * The parent constructs this environment only after managed ownership admission.
 * This is not authentication against hostile installed extensions or an OS sandbox.
 * Consume before either factory registers tools: load order must not grant background
 * execution, and arbitrary shell/nested Pi grandchildren must not inherit identity.
 * The existing guard copy survives reload/resume within this process only.
 */
export function consumeManagedChildGuard(): any {
  const slot = globalThis as { __piSubagentsGuardExpected?: any };
  const encoded = process.env.PI_SUBAGENTS_GUARD;
  if (encoded) {
    delete process.env.PI_SUBAGENTS_GUARD;
    // The parent always writes valid JSON. A broken value is a configuration mistake: ignore it for every consumer
    // (instead of letting the first one throw and the rest see nothing) and say so once.
    try { slot.__piSubagentsGuardExpected = JSON.parse(encoded); }
    catch { process.emitWarning("PI_SUBAGENTS_GUARD is not valid JSON and was ignored; this process is not treated as a managed child."); }
  }
  return slot.__piSubagentsGuardExpected;
}

export function isManagedForegroundChild(): boolean {
  const expected = consumeManagedChildGuard();
  return expected?.shellMode === "foreground-v1"
    && typeof expected.id === "string" && expected.id.length > 0
    && typeof expected.cwd === "string" && expected.cwd.length > 0
    && typeof expected.startupPath === "string" && expected.startupPath.length > 0;
}
