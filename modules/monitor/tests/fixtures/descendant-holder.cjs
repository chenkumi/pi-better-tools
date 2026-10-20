// Test-only descendant: records its pid, inherits stdout/stderr silently, and always exits by itself.
require('node:fs').writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => process.exit(0), 20000);
