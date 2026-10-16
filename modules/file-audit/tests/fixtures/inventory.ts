import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
export function inventories() {
  return {
    sources: { modules: [{ module: "fixture", files: [{ path: "a.ts", sha256: digest("original") }] }] },
    adaptations: { files: [{ path: "modules/fixture/a.ts", originalSha256: digest("original"), sha256: digest("current"), reason: "Reviewed fixture" }],
      addedFiles: [{ path: "tests/added.ts", sha256: digest("added"), reason: "New fixture" }], removedFiles: [] as Record<string, unknown>[],
      localSourceSuiteFinalIntegration: { rootFiles: [{ path: "README.md", sha256: digest("readme") }] } },
    native: { modules: [{ module: "native", origin: "Native fixture", license: "MIT", entry: "modules/native/index.ts",
      files: [{ path: "modules/native/index.ts", sha256: digest("native") }] }] },
  };
}
export async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "file-audit-scan-")), data = inventories();
  const save = async () => {
    for (const [name, value] of [["sources", data.sources], ["adaptations", data.adaptations], ["native-modules", data.native]] as const) {
      await writeFile(join(cwd, "docs", `${name}.json`), JSON.stringify(value));
    }
  };
  for (const dir of ["docs", "modules/fixture", "modules/native", "tests"]) await mkdir(join(cwd, dir), { recursive: true });
  await writeFile(join(cwd, "modules/fixture/a.ts"), "current");
  await writeFile(join(cwd, "modules/native/index.ts"), "native");
  await writeFile(join(cwd, "tests/added.ts"), "added");
  await writeFile(join(cwd, "README.md"), "readme");
  await save();
  return { cwd, ...data, save, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
