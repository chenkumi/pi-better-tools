// Child process (run with --experimental-test-module-mocks) for the DEGRADED D22 case where the OS refuses symlink creation.
// node:fs.realpathSync is mocked so that <agentDir>/settings.json "resolves" to <other>/settings.json, exactly what a real
// settings.json symlink does for the module's lock path. Pi's host storage, proper-lockfile and the module are all real.
import { mock } from 'node:test';
import * as realFs from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , root, workDir] = process.argv;
const agentDir = join(workDir, 'agent'), other = join(workDir, 'elsewhere'), cwd = join(workDir, 'ws');
for (const d of [agentDir, other, cwd]) mkdirSync(d, { recursive: true });
writeFileSync(join(agentDir, 'settings.json'), '{}'); writeFileSync(join(other, 'settings.json'), '{}');
const linkPath = resolve(agentDir, 'settings.json');
const realpathSync = Object.assign((p, ...rest) => resolve(String(p)) === linkPath ? resolve(other, 'settings.json') : realFs.realpathSync(p, ...rest), { native: realFs.realpathSync.native });
mock.module('node:fs', { exports: { ...realFs, realpathSync, default: { ...realFs, realpathSync } } });
const { probe } = await import(new URL('../../../tests/helpers/regression/d22-probe.mjs', import.meta.url).href);
const result = await probe({ root, hostAgentDir: agentDir, moduleSettingsReadPath: join(other, 'settings.json'), cwd });
console.log(JSON.stringify(result));
