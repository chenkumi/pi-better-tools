import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnostic, feedback, safeText } from '../src/policy.js';

test('safeText masks the whole credential after an unquoted authorization key', () => {
  for (const [input, secret] of [
    ['Request failed: Authorization: Bearer FAKETOKEN123abc', 'FAKETOKEN123abc'],
    ['error authorization=Basic ZmFrZTpjcmVkRkFLRQ==', 'ZmFrZTpjcmVkRkFLRQ=='],
    ['Authorization: Bearer ya29.A0ARrdaM-secret then more text', 'ya29.A0ARrdaM-secret'],
    ['authorization: token abc123', 'abc123'],
  ] as const) {
    assert.ok(!safeText(input).includes(secret), `leaked from: ${input}`);
  }
  assert.equal(safeText('Authorization: Bearer abc123 and then other text'), 'Authorization: "[REDACTED]" and then other text');
});

test('safeText keeps its existing behaviour for quoted, JSON, bare and ordinary values', () => {
  assert.equal(safeText('header "authorization": "Bearer FAKEQUOTED999" failed'), 'header "authorization": "[REDACTED]" failed');
  assert.equal(safeText('{"authorization":"Bearer FAKEJSON777"}'), '{"authorization":"[REDACTED]"}');
  assert.equal(safeText('got Bearer FAKEBARE555 rejected'), 'got Bearer [REDACTED] rejected');
  assert.equal(safeText('api_key=abc123 next'), 'api_key="[REDACTED]" next');
  assert.equal(safeText('plain failure, nothing secret'), 'plain failure, nothing secret');
});

test('recovery diagnostics and feedback never carry the credential', () => {
  const d = diagnostic({ stopReason: 'error', errorMessage: '400 Authorization: Bearer FAKETOKEN123abc', provider: 'p', model: 'm', timestamp: 0 }, 'e1');
  assert.ok(!d.message.includes('FAKETOKEN123abc'));
  assert.ok(!feedback(d, 1).includes('FAKETOKEN123abc'));
});
