import * as fs from "node:fs";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { SessionError } from "./session-store.ts";

export const MAX_SKILLS_PER_TASK = 8;

export interface SkillCommand { name: string; source: string; sourceInfo: { path: string } }

/** Skill command names are `skill:<name>`; callers may pass either spelling. */
const bareName = (name: string) => name.trim().replace(/^skill:/, "");

/** Only the SKILL.md body is embedded; references/scripts stay on disk and are reachable through `location`. */
export function buildSkillBlock(name: string, location: string, content: string): string {
	return `<skill name="${name}" location="${location}">\n${stripFrontmatter(content).trim()}\n</skill>`;
}

/** The task text a child receives: skills first, then the `Task:` line. */
export function taskPromptText(task: string, skillBlock?: string): string {
	return `${skillBlock ? `${skillBlock}\n\n` : ""}Task: ${task}`;
}

/**
 * Resolves skills already loaded by the host (never scans directories itself, so project-trust
 * decisions made by Pi stay in force) and returns one embeddable block, or undefined when none were requested.
 */
export async function resolveSkillBlock(names: readonly string[] | undefined, commands: readonly SkillCommand[]): Promise<string | undefined> {
	if (!names?.length) return undefined;
	if (names.length > MAX_SKILLS_PER_TASK) throw new SessionError("INVALID_DISPATCH", `skills accepts at most ${MAX_SKILLS_PER_TASK} names per task; received ${names.length}.`);
	const available = new Map(commands.filter(command => command.source === "skill").map(command => [bareName(command.name), command.sourceInfo.path]));
	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const requested of names) {
		const name = bareName(requested);
		if (seen.has(name)) throw new SessionError("INVALID_DISPATCH", `skills contains duplicate "${name}".`);
		seen.add(name);
		const location = available.get(name);
		if (!location) throw new SessionError("INVALID_DISPATCH", `Unknown skill: "${name}". Available skills: ${[...available.keys()].map(key => `"${key}"`).join(", ") || "none"}.`);
		let content: string;
		try { content = await fs.promises.readFile(location, "utf8"); }
		catch (error) { throw new SessionError("INVALID_DISPATCH", `Unable to read skill "${name}" at ${location}: ${error instanceof Error ? error.message : String(error)}`); }
		blocks.push(buildSkillBlock(name, location, content));
	}
	return blocks.join("\n\n");
}
