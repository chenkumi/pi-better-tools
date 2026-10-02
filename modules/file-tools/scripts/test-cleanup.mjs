// Run every cleanup even if an earlier release fails. A cleanup failure must
// remain observable without replacing an already pending primary test error.
export async function cleanupTestResources(actions, primaryError) {
  const errors = [];
  for (const [label, release] of actions) {
    try { await release(); } catch (error) {
      errors.push(new Error(`Cleanup failed (${label}): ${String(error)}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    const failure = new AggregateError(errors, "Test resource cleanup incomplete");
    if (primaryError !== undefined) console.error(failure);
    else throw failure;
  }
  return { status: errors.length === 0 ? "complete" : "incomplete", errors: errors.map(String) };
}
