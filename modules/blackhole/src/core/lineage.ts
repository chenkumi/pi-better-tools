export interface LineageEntryLike {
  id?: string;
}

export interface LineageSessionManagerLike {
  getBranch: () => LineageEntryLike[];
  getEntries?: () => LineageEntryLike[];
}

export const getActiveLineageEntryIds = (
  sessionManager: LineageSessionManagerLike,
): Set<string> => {
  try {
    const branch = sessionManager.getBranch() ?? [];
    // Empty or unavailable lineage never grants abandoned-branch authority.
    return new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
  } catch {
    return new Set();
  }
};
