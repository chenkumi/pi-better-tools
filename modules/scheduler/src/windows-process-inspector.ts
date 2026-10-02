import type { CommandRunner, ProcessIdentitySnapshot, ProcessInspector, ProcessTerminator } from "./runtime-deps.js";

export class WindowsProcessInspector implements ProcessInspector, ProcessTerminator {
  constructor(private readonly commands: CommandRunner) {}

  async inspect(pid: number): Promise<ProcessIdentitySnapshot | undefined> {
    const script = `Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`;
    const result = await this.commands.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
    const item = JSON.parse(result.stdout) as { ProcessId: number; CreationDate: string; CommandLine: string };
    return { pid: item.ProcessId, startedAt: new Date(item.CreationDate).toISOString(), commandLine: item.CommandLine };
  }

  async terminateTree(pid: number): Promise<void> {
    const result = await this.commands.run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    if (result.exitCode !== 0) throw new Error(result.stderr || `taskkill failed for ${pid}`);
  }
}
