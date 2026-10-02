function normalizeSkillMatchPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Return the unique loaded skill path matching a missing `<skill-dir>/SKILL.md` request. */
export function findUniqueSkillFallbackPath(requestedPath: string, skillPaths: readonly string[]): string | undefined {
  const requested = normalizeSkillMatchPath(requestedPath);
  const requestedParts = requested.split("/");
  const fileName = requestedParts.at(-1);
  const skillDirectory = requestedParts.at(-2);
  if (!fileName || !skillDirectory || requestedParts.length < 2) return undefined;

  const isWindows = process.platform === "win32";
  const comparable = (value: string) => isWindows ? value.toLowerCase() : value;
  if (comparable(fileName) !== comparable("SKILL.md")) return undefined;

  const suffix = `/${skillDirectory}/SKILL.md`;
  const matches = skillPaths.filter((skillPath) => comparable(normalizeSkillMatchPath(skillPath)).endsWith(comparable(suffix)));
  if (matches.length !== 1) return undefined;
  if (comparable(normalizeSkillMatchPath(matches[0])) === comparable(requested)) return undefined;
  return matches[0];
}
