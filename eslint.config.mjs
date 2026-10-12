import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Correctness baseline for imported snapshots; formatting and type analysis
// remain separate concerns. Do not rewrite upstream code with --fix.
const files = [
  'modules/**/{src,extensions,tests,test,scripts}/**/*.{ts,js,mjs,cjs}',
  'modules/*/index.ts',
  'modules/*/vitest.config.ts',
  'scripts/**/*.{ts,js,mjs,cjs}',
  'tests/**/*.{ts,js,mjs,cjs}',
  '*.mjs',
];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.pi/**', '**/plan/**', '**/report/**', '**/research/**', '**/issue/**', '**/task/**'] },
  {
    files,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    // Upstream directives may reference type-aware rules outside this baseline.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-debugger': 'error',
      'no-dupe-else-if': 'error',
      'no-unsafe-finally': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
  { files: ['**/*.ts'], languageOptions: { parser: tsParser }, plugins: { '@typescript-eslint': tsPlugin } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
