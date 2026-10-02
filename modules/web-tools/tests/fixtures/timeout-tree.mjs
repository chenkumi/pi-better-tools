import { spawn } from 'node:child_process';
console.log(`root:${process.pid}`);
spawn(process.execPath, ['-e', 'console.log(`grand:${process.pid}`); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
  stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32', windowsHide: true,
});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
