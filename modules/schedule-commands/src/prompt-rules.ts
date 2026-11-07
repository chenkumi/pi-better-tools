export const SCHEDULE_RULES_SECTION = "schedule_rules";

/** Rules for the schedule tools; present only while one of them is active. */
export function renderScheduleRules(active: ReadonlySet<string>): string | undefined {
	const prompt = active.has("schedule_prompt"), shell = active.has("schedule_shell"), monitor = active.has("schedule_monitor");
	if (!prompt && !shell && !monitor) return undefined;
	return [
		"**Schedules**",
		"- Create or change a schedule only when the user asks. Schedules run only while Pi is open; they are not OS jobs.",
		...(shell ? ["- Put commands in schedule_shell; the user confirms the exact command."] : []),
		...(prompt ? ["- schedule_prompt delivers text to this conversation, or runs a separate agent session when you give a model."] : []),
		...(monitor ? ["- schedule_monitor starts a monitor (monitor_start parameters) at each scheduled time. To watch a scheduled command, schedule both for the same time; the command starts first."] : []),
		"- A scheduled turn may only list, inspect, disable or remove schedules, never create or start work.",
	].join("\n");
}
