# shared

Pure library code used by several modules under `modules/`. It is not a Pi extension: it has no entry in the
`pi.extensions` manifest and registers nothing by itself.

## Rules

- **No registration on import.** Importing any `shared/src/<area>/index.ts` must not call `registerTool`,
  `registerCommand`, `on` or any other host API, and must not have other side effects. Helpers that take `pi`
  (for example a settings-panel registration function) may live here, but only run when a module calls them
  from its own entry. `tests/no-import-side-effects.test.ts` enforces that importing an area needs no host and adds no globals.
- **One-way dependency.** `modules/*` may import `shared/`; `shared/` must not import `modules/` or any other
  project directory (`tests/unit/module-import-boundary.test.mjs`).
- **Public surface.** Only `shared/src/<area>/index.ts` is public. Modules never import files inside an area.
- **Shipped.** `shared/src` and this file are in the package `files`; `shared/tests` is not.
- No separate license: the root `LICENSE` applies.

## Areas

| Area | Content | Phase |
|---|---|---|
| `contracts/` | Tool-name constants and cross-module result shapes | P3 |
| `prompt/` | Forced/custom system-prompt appender | P1 |
| `background/` | Background job panel, job view, live transcript, Monitor capability | P5 |
| `settings-panel/` | `/settings:<id>` panel library | P5b |

Checks: `npm run test:module -- shared` (typecheck + unit tests).
