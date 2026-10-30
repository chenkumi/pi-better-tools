export declare function browserInvocation(
  action: 'install' | 'install-deps' | 'setup',
  options?: { execPath?: string; cwd?: string; env?: NodeJS.ProcessEnv },
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
