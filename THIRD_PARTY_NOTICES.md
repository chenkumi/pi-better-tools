# Source and dependency notices

Pi Better Tools is licensed under the MIT License in the root `LICENSE`.
On 2026-10-01, the project owner confirmed ownership of all five source projects and explicitly requested MIT licensing for this integration. On 2026-10-03, the owner requested that packaging rely on the root `LICENSE`, without requiring duplicate module LICENSE files. Original Subagents/Web copyright and permission notices remain preserved; the redundant integration-added File LICENSE is removed. The original five source directories were not modified.

| Module | Original package | License in this integration |
| --- | --- | --- |
| subagents | pi-subagents 0.1.0 | MIT; original `modules/subagents/LICENSE` preserved |
| shell-tools | pi-shell-timeout-ms 0.1.0 | MIT; covered by the root `LICENSE`, no duplicate module LICENSE required |
| file-tools | pi-precise-file-tools 0.1.0 | MIT; covered by the root `LICENSE`, redundant integration-added module LICENSE removed |
| web-tools | pi-web-tools 0.1.0 | MIT; original `modules/web-tools/LICENSE` preserved |
| pty-terminal | pi-pty-terminal 0.1.0 | MIT; owner confirmed ownership and requested integration; original `modules/pty-terminal/LICENSE` preserved |
| schedule-prompt | pi-schedule-prompt 0.4.1 (tintinweb) | MIT, Copyright (c) tintinweb; third-party source, not owner-confirmed; original `modules/schedule-prompt/LICENSE` preserved and not re-licensed |
| blackhole | pi-blackhole 0.5.12 (k0valik) | MIT; third-party snapshot, original `modules/blackhole/LICENSE` preserved; no ownership claim or re-licensing |
| json-schema | project-native rewrite (2026-10-02) | MIT (root `LICENSE`); written from documented behavior only and contains no code from the former @nqbao/pi-json-schema import, whose source is no longer available |

The Shell/File import snapshots originally had no root LICENSE or package license field. That historical observation remains in import provenance; it is no longer an unresolved permission blocker for this integration after the owner's confirmation and MIT request.

JSON Schema was first imported on 2026-10-02 from @nqbao/pi-json-schema 0.1.1 (MIT) and later fully rewritten as a project-native module (see `docs/native-modules.json`; the retired import is recorded under `retiredImports` in `docs/sources.json`). It validates with `zod` 4.6.5 (MIT), which keeps its own license; Ajv is no longer a dependency. No host Pi implementation or official-example code is bundled.

Keep the root and module copyright/permission notices with redistributed copies. Existing module licenses were not replaced or revoked. Runtime dependencies retain their own package licenses; the root MIT license does not relicense those dependencies. Pi packages and TypeBox are declared as host-provided peers, not bundled runtime implementations.

`private: true` remains an npm publication safeguard, not a restriction on making this repository public on GitHub. No GitHub upload or npm publication was performed as part of adding the license.

Repository import provenance is recorded in `docs/sources.json`; reviewed local persistence and license-metadata adaptations are recorded in `docs/adaptations.json`. Original module README/package identity and independent development/version claims are historical; the integrated manifest and validation records define this package's current behavior. Contributor notes/tests/reports are not runtime package resources.

## npm Pi extension dependencies (local-source suite)

2026-10-08: at the user's request, the root declares `pi-open-tui` 0.3.11 (OldSuns, MIT), `pi-blackhole` 0.5.11 (k0valik, MIT), and `@ff-labs/pi-fff` 0.11.0 (FFF project, MIT) as pinned npm dependencies. Pi loads their original extension entries from the repository's installed node_modules; their source is not copied into modules, altered, or re-licensed. Preserve each installed package's LICENSE/copyright and all transitive dependency notices when redistributing copies. FFF's native/FFI dependencies retain their own licenses and platform distributions. These are external runtime dependencies, not newly owner-confirmed source snapshots or host Pi implementations. No npm/GitHub publication or automatic personal-settings migration is authorized by this integration.

## Vendored Blackhole

2026-10-09: at the user's request, Blackhole is now copied from the local 0.5.12 source checkout (commit `a2e4c13`) into `modules/blackhole/`, replacing the former npm 0.5.11 dependency. Preserve its original MIT LICENSE/copyright and source identity; this authorization is not an ownership declaration. Local adaptations are the direct TS forwarding entry/private metadata, chronological display-copy selector and matching host-order regression fixtures. Source hashes and upstream pnpm lock identity are recorded without importing node_modules or a nested lockfile. Personal configuration, memory and old sessions are not migrated or rewritten. The 2026-10-08 npm suite record above remains historical; only pi-open-tui and pi-fff remain external npm extension dependencies.

## PTY dependencies

2026-10-03: imported the owner's `C:/GitHub/pi-pty-terminal` snapshot without modifying its repository. Source README describes a port from `opencode-pty-mcp`; the source MIT notice is preserved. Root runtime dependency `node-pty` 1.2.0-beta.14 (MIT, Microsoft Corporation) and its `node-addon-api` dependency keep their own package licenses and third-party notices (including native backend resources); they are not relicensed by this integration. Native dependency setup is explicitly rebuildable with `npm run pty:install`; no host Pi code is bundled.

## Schedule Prompt dependencies

2026-10-06: imported `D:/GitHub/pi-schedule-prompt-master` (pi-schedule-prompt 0.4.1, no VCS metadata) without modifying that folder. Root runtime dependencies `croner` 10.0.1 (MIT) and `nanoid` 5.1.16 (MIT) and devDependency `vitest` 4.0.18 (MIT) keep their own licenses; they are not re-licensed.

## Native Monitor and ws

2026-10-09: Monitor v1 is project-native MIT code (`modules/monitor/LICENSE`, root LICENSE), not an upstream snapshot. Root direct `ws` 8.22.0 (MIT, Copyright (c) 2011 Einar Otto Stangvik and contributors) and development-only `@types/ws` 8.18.1 retain their own licenses. Optional ws native addons are not necessary for Monitor. Pi1.1.0 Shell internals are resolved relative to the installed host to reuse environment/tracking/cancellation; no host implementation is copied or bundled. Public generated TLS key/certificate fixtures are test-only, never runtime credentials and excluded from tarballs.

## ulid

2026-10-02: the root package added the runtime dependency `ulid` 3.0.2 (MIT, Copyright (c) 2017 Alizain Feerasta; no transitive dependencies) to generate ULID identifiers in place of `node:crypto` `randomUUID()`. It keeps its own MIT license; it is not re-licensed.
