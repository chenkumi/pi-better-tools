# Pi 1.2.0 baseline upgrade (2026-10-14)

## Changes
- Root devDependencies `@earendil-works/pi-{agent-core,ai,coding-agent,tui}` 1.1.0 → 1.2.0; lockfile regenerated with `npm install --ignore-scripts` (only the Pi packages and their `@earendil-works/*` transitive packages changed; `chord` is no longer a dependency).
- Version gates/fixture assertions `1.1.0` → `1.2.0` (Monitor command backend `VERSION` check, host fixtures, docs). Subagents `hostContract: "0.99.1"` unchanged.
- 1.2.0 API adaptation in tests: `ExtensionRunner.emitBeforeAgentStart(trigger, options)` now takes a trigger object (`tests/fixtures/smoke.mjs`, `modules/shell-tools/tests/background-guidance.integration.test.mjs`); the notification-batching preflight-failed fixture fails only `messageType === 'user'` runs, because 1.2.0 also fires `before_agent_start` for the custom-message run that delivers the completion.
- `scripts/package-smoke.mjs`: `chord` removed from the pinned host-transitive list.
- Schedule-prompt command jobs: `abortGraceMs` (500 ms) and `exitIdleMs` (250 ms) opt-ins in `execMonitorCommand`, 5 s close-wait fallback.

## Verification (2026-10-14, Pi 1.2.0)
- `npm run typecheck` 14/14, `npm test` 16/16 (2791 + 391 vitest), `npm run lint` clean.
- `npm run test:integration` 20/20 after the two fixes above (first run: 18/20; shell-tools background-guidance and notification-batching preflight-failed, plus all-modules smoke, were the 1.2.0 API adaptations).
- `npm run test:package`: 1.2.0 production tarball smoke passed. `npm run test:cross` 4/4. `node scripts/verify-sources.mjs` exit 0.
- Not run: `npm run test:browser` (Web real-browser tests; Web code unchanged).

## Remaining risk
- Pi host `killProcessTree` is unchanged in 1.2.0 (fire-and-forget `taskkill /F /T`); the cancel-right-after-spawn grandchild race is mitigated, not removed.
- Real providers and a real personal Pi 1.2.0 installation were not exercised.
