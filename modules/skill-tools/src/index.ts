import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const skillsDirectory = fileURLToPath(new URL('../skills/', import.meta.url));

export default function skillTools(pi: ExtensionAPI) {
  pi.on('resources_discover', () => ({ skillPaths: [skillsDirectory] }));
}
