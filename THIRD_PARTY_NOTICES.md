# Source and dependency notices

Pi Better Tools is licensed under the MIT License in the root `LICENSE`.
On 2026-10-01, the project owner confirmed ownership of all five source projects and explicitly requested MIT licensing for this integration. Shell/File license files and metadata were added to the local module snapshots with that authorization; the original five source directories were not modified.

| Module | Original package | License in this integration |
| --- | --- | --- |
| subagents | pi-subagents 0.1.0 | MIT; original `modules/subagents/LICENSE` preserved |
| shell-tools | pi-shell-timeout-ms 0.1.0 | MIT; `modules/shell-tools/LICENSE` added at the owner's request |
| file-tools | pi-precise-file-tools 0.1.0 | MIT; `modules/file-tools/LICENSE` added at the owner's request |
| web-tools | pi-web-tools 0.1.0 | MIT; original `modules/web-tools/LICENSE` preserved |
| scheduler | pi-scheduler 0.1.0 | MIT; the module `LICENSE` was removed at the owner's request, covered by the root `LICENSE` |
| json-schema | project-native rewrite (2026-10-02) | MIT (root `LICENSE`); written from documented behavior only and contains no code from the former @nqbao/pi-json-schema import, whose source is no longer available |

The Shell/File import snapshots originally had no root LICENSE or package license field. That historical observation remains in import provenance; it is no longer an unresolved permission blocker for this integration after the owner's confirmation and MIT request.

JSON Schema was first imported on 2026-10-02 from @nqbao/pi-json-schema 0.1.1 (MIT) and later fully rewritten as a project-native module (see `docs/native-modules.json`; the retired import is recorded under `retiredImports` in `docs/sources.json`). It validates with `zod` 4.6.5 (MIT), which keeps its own license; Ajv is no longer a dependency. No host Pi implementation or official-example code is bundled.

Keep the root and module copyright/permission notices with redistributed copies. Existing module licenses were not replaced or revoked. Runtime dependencies retain their own package licenses; the root MIT license does not relicense those dependencies. Pi packages and TypeBox are declared as host-provided peers, not bundled runtime implementations.

`private: true` remains an npm publication safeguard, not a restriction on making this repository public on GitHub. No GitHub upload or npm publication was performed as part of adding the license.

Repository import provenance is recorded in `docs/sources.json`; reviewed local persistence and license-metadata adaptations are recorded in `docs/adaptations.json`. Original module README/package identity and independent development/version claims are historical; the integrated manifest and validation records define this package's current behavior. Contributor notes/tests/reports are not runtime package resources.

## ulid

2026-10-02: the root package added the runtime dependency `ulid` 3.0.2 (MIT, Copyright (c) 2017 Alizain Feerasta; no transitive dependencies) to generate ULID identifiers in place of `node:crypto` `randomUUID()`. It keeps its own MIT license; it is not re-licensed.
