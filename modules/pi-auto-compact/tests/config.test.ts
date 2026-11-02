import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configPath, DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/config.ts';

function agentDir() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('defaults match the plan and the file lives directly under the agent dir', () => {
  assert.deepEqual({ ...DEFAULT_CONFIG }, { l1Ratio: 0.3, l1MinChars: 30000, l2Ratio: 0.2, l2MinChars: 20000, l3Ratio: 0.1, l3MinChars: 10000, l4Ratio: 0.1, l4MinChars: 10000, charsPerToken: 2.2, maxTotalRatio: 0.5 });
  assert.equal(configPath('/a/b'), join('/a/b', 'auto-compact.json'));
});

test('a missing file means defaults and nothing is created', () => {
  const { dir, done } = agentDir();
  try {
    const loaded = loadConfig(dir);
    assert.ok(loaded.ok && loaded.source === 'default');
    if (loaded.ok) assert.deepEqual(loaded.config, { ...DEFAULT_CONFIG });
    assert.deepEqual(readdirSync(dir), []);
  } finally { done(); }
});

test('a valid file overrides only the keys it names and is never rewritten', () => {
  const { dir, done } = agentDir();
  try {
    const text = '{ "l1Ratio": 0.4, "charsPerToken": 3 }\n';
    writeFileSync(configPath(dir), text);
    const loaded = loadConfig(dir);
    assert.ok(loaded.ok && loaded.source === 'file');
    if (loaded.ok) assert.deepEqual(loaded.config, { ...DEFAULT_CONFIG, l1Ratio: 0.4, charsPerToken: 3 });
    assert.equal(readFileSync(configPath(dir), 'utf8'), text);
  } finally { done(); }
});

test('unknown keys, wrong types and out-of-range values are errors, not fallbacks', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ enabled: true }, /unknown key: enabled/],
    [{ a: 1, b: 2 }, /unknown keys: a, b/],
    [{ l1Ratio: '0.3' }, /l1Ratio must be a finite number/],
    [{ l2Ratio: 0 }, /l2Ratio must be greater than 0 and at most 1/],
    [{ l4Ratio: 2 }, /l4Ratio must be greater than 0 and at most 1/],
    [{ l4MinChars: 0 }, /l4MinChars must be a positive integer/],
    [{ maxTotalRatio: 1.5 }, /maxTotalRatio must be greater than 0 and at most 1/],
    [{ l3MinChars: 1.5 }, /l3MinChars must be a positive integer/],
    [{ l1MinChars: -1 }, /l1MinChars must be a positive integer/],
    [{ charsPerToken: 0.5 }, /charsPerToken must be between 1 and 8/],
    [[], /one JSON object/],
    [null, /one JSON object/],
  ];
  for (const [raw, pattern] of cases) {
    const result = parseConfig(raw);
    assert.ok(!result.ok, JSON.stringify(raw));
    if (!result.ok) assert.match(result.error, pattern);
  }
});

test('invalid JSON and a directory in place of the file are reported with the path', () => {
  const { dir, done } = agentDir();
  try {
    writeFileSync(configPath(dir), '{ nope');
    const bad = loadConfig(dir);
    assert.ok(!bad.ok && bad.error.includes(configPath(dir)) && /not valid JSON/.test(bad.error));
    rmSync(configPath(dir));
    mkdirSync(configPath(dir));
    const unreadable = loadConfig(dir);
    assert.ok(!unreadable.ok && /cannot read/.test(unreadable.error));
  } finally { done(); }
});
