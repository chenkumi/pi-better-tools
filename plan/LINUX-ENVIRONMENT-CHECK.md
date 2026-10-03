# Current Linux environment validation

## Scope

Validated the current checkout on WSL2 Linux x86_64 (kernel 6.6.87.2), Node.js v24.18.0, npm 12.0.2, using the project's locked Pi 1.0.0. This is not a claim of compatibility with every Linux distribution, host version, real provider, or interactive TUI.

## Environment and preparation

- Workspace and /tmp are writable; approximately 932 GiB disk space and 14 GiB available memory were observed.
- `npm ci --ignore-scripts --no-audit --no-fund` succeeded (317 packages); lockfile and source files were not changed.
- `npm ls --depth=0` succeeded. Project-local Pi CLI reports 1.0.0.
- The PATH-resolved global `pi` is `/mnt/c/Users/ChenKuanMing/AppData/Roaming/npm/pi`; its Linux usability was not verified. Tests used the project-local Linux Node runtime and Pi.
- `npm run browser:install` downloaded Chromium v1243 into the user Playwright cache. Playwright also removed old chromium-1223/chromium_headless_shell-1223 cache directories automatically.
- No real credentials, paid providers, global Pi settings/auth/schedules, or OS services were used or modified. No system packages were installed and no elevation was attempted.

## Actual results

| Command | Result |
| --- | --- |
| npm run build | Passed: 1/1 stages |
| npm run typecheck | Passed: 8/8 stages |
| npm test | Failed: 8/10 stages succeeded; subagents and web-tools failed |
| npm run test:integration | Failed: 7/9 stages succeeded; file-tools packaging and subagents failed |
| npm run test:package | Failed at pack:dry-run contents parsing; production installation/runtime probes were not reached |
| npm run browser:install | Download succeeded, but does not supply missing OS libraries |
| npm run test:browser | Failed: 0/2 stages succeeded; real Chromium cannot launch |
| Single stderr close-deadline retest | Passed: 1 test; does not erase the original suite failure |

Nine extensions loaded under Pi 1.0.0 across full/read-only/no-tools/exclude/Brave/Exa/invalid-config/child scenarios. SDK hooks, Goal runtime, JSON Schema real CLI delivery, Scheduler source loader and Scheduler integration stages passed. These do not constitute real external-provider verification.

## Findings

1. **Browser runtime blocker:** direct Playwright Chromium launch exits 127 due to missing `libnspr4.so`. `ldd` additionally reports missing `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, and `libasound.so.2`. Browser-backed web_fetch cannot currently operate. Installing Playwright's Linux system dependencies requires a separately approved OS package installation; a typical command is `npx playwright install-deps chromium` (not executed).
2. **npm 12 packaging harness incompatibility:** `npm pack --dry-run --ignore-scripts --json` returns an object keyed by `pi-better-tools`, not the array assumed by `scripts/package-smoke.mjs:64`. Its `[0]` is undefined, producing `Cannot read properties of undefined (reading 'files')`. File-tools packaged-runtime integration likewise fails with `object is not iterable`. This is a validation-script blocker, not proof that the runtime tarball itself is broken; clean production verification remains incomplete.
3. **Web Windows-path normalization test fails on Linux:** `modules/web-tools/tests/unit/debug-log.test.ts:11` expects basename `my-project` for `C:\\work\\my-project`, but receives `C__work_my-project`. Windows-style input handling is not cross-platform as this test expects; normal Linux cwd debug-log tests passed.
4. **Subagent large-shell integration fixture is Windows-specific:** `modules/subagents/tests/fixtures/pi-provider.ts:60` invokes `powershell` with `Write-Output`. `modules/subagents/tests/pi-cli.integration.test.ts:121` expects a successful tool result but gets `isError: true`. The documented Pi PowerShell backend is native-Windows-only; this fixture does not validate equivalent large Bash output on Linux.
5. **Intermittent/unresolved Subagent close-deadline failure:** full unit execution timed out after 10000 ms in `modules/subagents/tests/runner-io.test.ts:242` (trailing stderr writes). Isolated retest passed in approximately 293 ms. Root cause and reliability under full-suite execution remain unconfirmed.

## Skips and unverified scope

- Unit tests skipped 11 Windows-only file-path cases.
- Shell integration skipped 1 native-Windows PowerShell case. Skips are not passes.
- Production tarball runtime validation and host matrix 0.99.1/0.99.2 were not completed/run.
- Interactive fullscreen TUI, real provider credentials, paid model calls, and real search-service requests were not tested.

## Evidence

- Per-stage results and logs: `plan/evidence/{build,typecheck,unit,integration,browser,package}.json` and associated `.log` files.
- Top-level command logs: `/tmp/pi-better-tools-linux-check/` (temporary, not durable).
- Diagnostic and retest logs: `/tmp/pi-better-tools-linux-check/chromium-diagnostic.log` and `subagent-retest.log`.

## Conclusion

The package can install its locked dependencies, build, typecheck, and load its extensions with substantial offline runtime coverage on this Linux environment. It cannot yet be described as fully operational or fully validated: browser-backed web_fetch is blocked by missing Linux libraries, packaging validation is incompatible with npm 12, and platform-specific plus unresolved intermittent test failures remain. No implementation fixes were made during this check.
