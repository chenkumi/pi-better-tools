import { fileURLToPath } from 'node:url';

export function formatSetupCommand(args, { platform = process.platform, execPath = process.execPath, cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)) } = {}) {
  if (!args.every(arg => typeof arg === 'string' && !/[\r\n\0]/u.test(arg))) throw new Error('Invalid setup arguments.');
  const quote = platform === 'win32'
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [execPath, cliPath, ...args].map(quote).join(' ');
  return platform === 'win32' ? `PowerShell: & ${command}` : `POSIX shell: ${command}`;
}

export function setupCommand(args) {
  return formatSetupCommand(args);
}
