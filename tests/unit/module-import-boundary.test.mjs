import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scan } from '../../tools/module-coupling/scan.mjs';

// Ratchet: every cross-directory import in module source is listed here. A new edge fails the test until
// it is reviewed and added; an edge that disappears fails it too, so the list can only shrink on purpose.
// Each refactoring phase of plan/module-decoupling-plan.md edits this list together with the code.
const ALLOWED = new Set([
  'fork -> modules/shell-tools/src/background-panel',
  'fork -> modules/shell-tools/src/job-view',
  'fork -> modules/shell-tools/src/live-transcript',
  'fork -> modules/shell-tools/src/managed-child',
  'fork -> modules/shell-tools/src/monitor-capability',
  'fork -> modules/shell-tools/src/widget-binding',
  'fork -> modules/subagents/extensions/subagent/concurrency',
  'fork -> modules/subagents/extensions/subagent/pi-invocation',
  'fork -> modules/subagents/extensions/subagent/query-snapshot',
  'fork -> modules/subagents/extensions/subagent/rpc',
  'fork -> modules/subagents/extensions/subagent/subsession-log',
  'monitor -> modules/shell-tools/src/background-panel',
  'monitor -> modules/shell-tools/src/job-view',
  'monitor -> modules/shell-tools/src/managed-child',
  'monitor -> modules/shell-tools/src/monitor-capability',
  'monitor -> modules/shell-tools/src/monitor-exec',
  'monitor -> modules/shell-tools/src/widget-binding',
  'monitor -> modules/web-tools/src/fetch/network',
  'pi-auto-compact -> modules/pi-runtime/src/settings-panel/index',
  'pi-auto-compact -> modules/shell-tools/src/monitor-capability',
  'pty-terminal -> modules/shell-tools/src/background-panel',
  'pty-terminal -> modules/shell-tools/src/job-view',
  'pty-terminal -> modules/shell-tools/src/monitor-capability',
  'pty-terminal -> modules/shell-tools/src/widget-binding',
  'pty-terminal -> setup/commands',
  'pty-terminal -> setup/core',
  'remote -> modules/pi-runtime/src/settings-panel/index',
  'remote -> modules/shell-tools/src/managed-child',
  'schedule-prompt -> modules/shell-tools/src/monitor-exec',
  'schedule-prompt -> modules/shell-tools/src/timeout-ms',
  'sql-connector -> modules/pi-runtime/src/settings-panel/index',
  'sqlite-tools -> modules/pi-runtime/src/settings-panel/index',
  'subagents -> modules/shell-tools/src/background-guidance',
  'subagents -> modules/shell-tools/src/background-panel',
  'subagents -> modules/shell-tools/src/detach-hint',
  'subagents -> modules/shell-tools/src/foreground-handoff',
  'subagents -> modules/shell-tools/src/job-view',
  'subagents -> modules/shell-tools/src/live-transcript',
  'subagents -> modules/shell-tools/src/managed-child',
  'subagents -> modules/shell-tools/src/manual-detach',
  'subagents -> modules/shell-tools/src/monitor-capability',
  'subagents -> modules/shell-tools/src/recovery',
  'subagents -> modules/shell-tools/src/widget-binding',
  'web-tools -> modules/pi-runtime/src/settings-panel/index',
]);

const strip = path => path.replace(/\.(?:ts|mjs|js)$/, '');
const { edges } = scan();
const sourceEdges = edges.filter(e => e.kind === 'src' && e.from !== 'shared');
const label = e => `${e.from} -> ${strip(e.target)}`;

test('module source only imports other directories that are on the allow-list', () => {
  const actual = new Set(sourceEdges.filter(e => e.to !== 'shared').map(label));
  const added = [...actual].filter(x => !ALLOWED.has(x)).sort();
  const removed = [...ALLOWED].filter(x => !actual.has(x)).sort();
  assert.deepEqual(added, [], 'new cross-directory imports (review, then add to ALLOWED)');
  assert.deepEqual(removed, [], 'allow-list entries no longer used (delete them from ALLOWED)');
});

test('shared/ never imports modules/ or other project directories', () => {
  const bad = edges.filter(e => e.from === 'shared').map(e => `${e.file} -> ${e.target}`);
  assert.deepEqual(bad, []);
});

test('modules import shared/ only through shared/src/<area>/index', () => {
  const bad = edges.filter(e => e.to === 'shared' && !/^shared\/src\/[^/]+\/index$/.test(strip(e.target)))
    .map(e => `${e.file} -> ${e.target}`);
  assert.deepEqual(bad, []);
});
