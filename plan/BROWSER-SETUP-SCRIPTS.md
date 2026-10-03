# Explicit browser setup scripts

## Changes

- Root package.json: add `browser:install-deps` (`playwright install-deps chromium`) and `setup:browser` (`playwright install --with-deps chromium --no-shell`). Existing browser:install remains download-only.
- README.md: document Linux/WSL2 installation, Linux CLI paths, explicit optional OS dependency installation, sudo requirements, browser cache cleanup and development-vs-runtime verification.
- docs/configuration.md and docs/adaptations.json: record setup behavior and provenance. No imported implementation or runtime dependency versions changed; no postinstall hook added.

## Validation

- `npm run browser:install-deps -- --help`: passed; correct Playwright command dispatch, no install.
- `npm run setup:browser -- --dry-run`: passed; arguments accepted, no install. Dry-run is not treated as proof of a successful OS package installation.
- JSON parsing and git diff --check: passed.
- npm run build: passed, 1/1 stages.
- npm run typecheck: passed, 8/8 stages.
- npm test: failed, 8/10 stages. Web Windows-path basename assertion still fails; file-tools tooling's npm resolution fixture timed out after 10000ms. Subagent unit stage passed this time.
- npm run test:integration: failed, 7/9 stages. Existing file-tools pack JSON parsing and Subagent Windows-specific large-shell fixture failures remain.
- npm run test:package: failed at npm 12 pack dry-run result parsing; production probes not reached.
- npm run test:browser: passed, 2/2 stages, 13 tests total, no skips. At revalidation, ldd no longer reported missing Chromium libraries. No system-dependency installer was executed by this work; the environment differs from the earlier Linux check, and this result does not prove the new OS-install command was actually exercised.
- Full unit/integration logs still contain platform-specific skips; they do not count as passes.

## Evidence and limits

- Latest stage reports/logs: plan/evidence/.
- Top-level command logs: /tmp/pi-better-tools-browser-setup/.
- No actual setup:browser/system package installation, sudo, global Pi settings changes or real paid provider calls performed.
- Existing package-lock.json deletion of Pi's `hasShrinkwrap` metadata was present before this change and preserved; no dependency version change. Earlier report's statement that the lockfile was unchanged should not be taken as a description of the current working tree.
- New scripts are direct Playwright commands and remain usable in a runtime tarball without repository helper scripts.
