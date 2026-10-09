import { join } from 'node:path';

// Deliberately do not inherit credentials, real settings overrides or child markers.
export function isolatedEnv(home) {
  const env = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    PI_CODING_AGENT_DIR: join(home, '.pi/agent'), PI_AGENT_DIR: join(home, '.pi/agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_BLACKHOLE_PASSIVE: 'true' };
}
