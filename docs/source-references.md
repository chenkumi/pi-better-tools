# Source-only contributor references

The nested `AGENTS.md` and README snapshots retain source-version claims and historical report links. Reports were deliberately not copied into the runtime package. They are contributor background, never runtime dependencies.

For this integration, root manifest/scripts/version matrix override source metadata. Do not create nested lockfiles or interpret source `npm install`, `test:compat`, `test:production` commands as the integrated workflow.

When making relevant changes, inspect the original reports in their immutable local source projects:

- File: `D:/projects/pi-file-tools/issues/SCAN-20260930-080901/FIX-REPORT.md`
- Subagents compatibility: `D:/projects/pi-subagents/issues/FIX-20260930-083537-pi-compatibility/REPORT.md`
- Subagents lifecycle reliability: `D:/projects/pi-subagents/issues/SCAN-20260917-subagent-reliability/REPORT.md`
- Web compatibility: `D:/projects/pi-web-tools/issues/SCAN-20260930-081037/REPORT.md` and `FIXES.md`

If originals are unavailable, obtain the required reference material before changing covered lifecycle/security contracts. These absolute paths identify documentation inputs only; shipped extensions must not use them.

`docs/sources.json` is the immutable import manifest. `docs/adaptations.json` lists the reviewed current hashes and reasons for every locally changed imported file. Verify the local snapshot using `npm run sources:verify`, or also compare immutable originals using `node scripts/verify-sources.mjs --originals` where those paths exist.
