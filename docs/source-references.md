# Source-only contributor references

The nested `AGENTS.md` and README snapshots retain source-version claims and historical report links. Reports were deliberately not copied into the runtime package. They are contributor background, never runtime dependencies.

For this integration, root manifest/scripts/version matrix override source metadata. Do not create nested lockfiles or interpret source `npm install`, `test:compat`, `test:production` commands as the integrated workflow.

When making relevant changes, inspect the original reports in their immutable local source projects:

- File: `D:/projects/pi-file-tools/issues/SCAN-20260930-080901/FIX-REPORT.md`
- Web compatibility: `D:/projects/pi-web-tools/issues/SCAN-20260930-081037/REPORT.md` and `FIXES.md`

If originals are unavailable, obtain the required reference material before changing covered lifecycle/security contracts. These absolute paths identify documentation inputs only; shipped extensions must not use them.

Historical source contents could not be located in the checked WSL paths during the Linux compatibility work. The 2026-10-12 Blackhole status-bar source/test acceptance is therefore an explicitly reviewed new local baseline, not a recovered historical reconciliation. Independent review (`report/REPORT-20261012T061203580Z.md`, supplemented by `report/REPORT-20261012T061350545Z.md`) covers current four-cell/half-cell tiers, memory gating, public usage/unknown and UI lifecycle. Low UI freshness/direct replacement and negative-matrix coverage limits remain; no product correction or comprehensive security certification is implied.

This project keeps no file hash records: `docs/sources.json`, `docs/adaptations.json`, `docs/native-modules.json` and `npm run sources:verify` were removed on 2026-10-26 at the user's request. Import identity and licensing stay documented in `THIRD_PARTY_NOTICES.md` and each module README/LICENSE. A copied snapshot is a local fork, not a synchronized mirror, and no automatic source synchronization exists.
