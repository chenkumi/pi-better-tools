import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCEPTED_TOKEN_LENGTHS, VERSION_TOKEN_ALTERNATIVES, VERSION_TOKEN_LENGTH, digestHex, isVersionToken, matchesVersionToken, shortenDigest, versionToken } from '../../src/version-token/index.ts';

test('the reported token is the first 16 hex characters of the full SHA-256', () => {
  const full = digestHex('content');
  assert.equal(full.length, 64);
  assert.equal(versionToken('content'), full.slice(0, 16));
  assert.equal(VERSION_TOKEN_LENGTH, 16);
  assert.deepEqual([...ACCEPTED_TOKEN_LENGTHS], [16, 32, 64]);
  assert.equal(versionToken(Buffer.from('content')), versionToken('content'));
  assert.equal(new RegExp(`^(?:${VERSION_TOKEN_ALTERNATIVES})$`).test(full.slice(0, 32)), true);
  assert.equal(new RegExp(`^(?:${VERSION_TOKEN_ALTERNATIVES})$`).test(full.slice(0, 20)), false);
});

test('tokens of 16, 32 and 64 characters match as prefixes, case-insensitively; other lengths and non-hex do not', () => {
  const full = digestHex('x');
  for (const length of [16, 32, 64]) {
    assert.equal(matchesVersionToken(full.slice(0, length), full), true);
    assert.equal(matchesVersionToken(full.slice(0, length).toUpperCase(), full), true);
  }
  for (const bad of [full.slice(0, 8), full.slice(0, 20), full.slice(0, 63), `${full.slice(0, 15)}g`, '', 'missing']) assert.equal(matchesVersionToken(bad, full), false, bad);
  assert.equal(matchesVersionToken(digestHex('y').slice(0, 16), full), false);
  assert.equal(matchesVersionToken(full.slice(0, 16), undefined), false);
  assert.equal(isVersionToken(full.slice(0, 16)), true);
  assert.equal(isVersionToken('abc'), false);
});

test('shortenDigest only cuts longer digests', () => {
  const full = digestHex('z');
  assert.equal(shortenDigest(full), full.slice(0, 16));
  assert.equal(shortenDigest(full.slice(0, 16)), full.slice(0, 16));
  assert.equal(shortenDigest(undefined), undefined);
});
