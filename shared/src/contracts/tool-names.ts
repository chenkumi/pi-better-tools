/**
 * Tool names that more than one module refers to. The owning module registers them; the others only name them
 * (system prompt rules, `--exclude-tools`, recovery projections). Each owner has a test that its registered tools
 * equal these constants, so a rename fails a test instead of drifting silently.
 */
export const SHELL_TOOLS = ['bash', 'powershell'] as const;
export const SHELL_JOB_TOOLS = ['shell_job_status', 'shell_job_cancel'] as const;
export const SUBAGENT_TOOLS = ['subagent', 'subagent_status', 'subagent_cancel', 'subagent_message'] as const;
export const FORK_TOOLS = ['fork', 'fork_status', 'fork_cancel', 'fork_message'] as const;
export const MONITOR_TOOLS = ['monitor_start', 'monitor_status', 'monitor_stop'] as const;
export const PROGRESS_CHECKPOINT_TOOL = 'progress_checkpoint';

/** Names that prompt rules mention. `grep` and `find` are provided by the FFF override, not by file-tools. */
export const FILE_INSPECT_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
export const FILE_EDIT_TOOLS = ['edit', 'write'] as const;
export const WEB_TOOLS = ['web_fetch', 'web_search'] as const;

export type ToolName = string;
export const isOneOf = (names: readonly string[], name: string): boolean => names.includes(name);
