import { spawn } from 'node:child_process';
import { basename } from 'node:path';

// npm run exports user/global allow-scripts as an env (CLI) policy, which npm 12
// rejects for project installs. Drop only that inherited setting; the fixed
// node-pty version remains explicitly approved in the project package.json.
const npmCli = process.env.npm_execpath;
if (!npmCli || basename(npmCli) !== 'npm-cli.js') throw new Error('Use npm run pty:install to resolve the active npm CLI.');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const child = spawn(process.execPath, [npmCli, 'rebuild', 'node-pty', '--foreground-scripts'], { env, stdio: 'inherit' });
const heartbeat = setInterval(() => console.log('[pty install] Native setup running...'), 10000);
child.once('error', error => { clearInterval(heartbeat); console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { clearInterval(heartbeat); process.exitCode = code ?? 1; });
