export const RUNNER_REWRITE_TARGETS = Object.freeze([
  { key: 'process-import', text: "from '../modules/file-tools/scripts/test-process.mjs'", count: 1 },
  { key: 'root', text: "const root = fileURLToPath(new URL('../', import.meta.url));", count: 1 },
  { key: 'tsx-resolution', text: "import.meta.resolve('tsx')", count: 4 },
  { key: 'pi-resolution', text: "import.meta.resolve('@earendil-works/pi-coding-agent')", count: 1 },
  { key: 'evidence', text: "const evidence = join(root, 'plan/evidence');", count: 1 },
]);

/** Pure extraction of the evidence-only rewrites; never executes source. */
export function transformModuleRunner(source, { root, processImportURL, tsxURL, piURL, evidenceRelative }) {
  // Check the entire original snapshot before transforming anything. Format
  // drift must fail before dynamic import can execute a runner or write logs.
  for (const target of RUNNER_REWRITE_TARGETS) {
    const found = source.split(target.text).length - 1;
    if (found !== target.count) throw new Error(`Root module runner changed: ${target.key} expected ${target.count} occurrences, found ${found}; refusing execution`);
  }
  const replacements = [
    `from ${JSON.stringify(processImportURL)}`, `const root = ${JSON.stringify(root)};`,
    JSON.stringify(tsxURL), JSON.stringify(piURL), `const evidence = join(root, ${JSON.stringify(evidenceRelative)});`,
  ];
  for (const [index, target] of RUNNER_REWRITE_TARGETS.entries()) source = source.replaceAll(target.text, replacements[index]);
  return source;
}
