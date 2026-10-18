// Legacy source entry delegates to the same installed-package CLI implementation.
import { main } from '../../../setup/core.mjs';

try {
  process.exitCode = await main(['pty', 'setup']);
} catch (error) {
  console.error(`[setup] ${error instanceof Error ? error.message : 'Native setup failed.'}`);
  process.exitCode = 1;
}
