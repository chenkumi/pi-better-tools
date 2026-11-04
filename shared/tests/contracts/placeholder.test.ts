import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARED_CONTRACTS_READY } from '../../src/contracts/index.ts';

test('shared contracts entry loads', () => assert.equal(SHARED_CONTRACTS_READY, true));
