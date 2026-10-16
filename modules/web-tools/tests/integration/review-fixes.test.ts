import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser } from 'playwright';
import { FetchService, type FetchOptions } from '../../src/fetch/service.js';

const options: FetchOptions = { channel: 'chromium', timeoutMs: 10_000, maxConcurrency: 1, idleTimeoutMs: 60_000 };
const internals = (service: FetchService) => service as unknown as { getBrowser(): Promise<Browser>; browser?: Browser; unconfirmedBrowser?: Browser; closingBrowsers: Set<unknown> };

test('G3-002: a rejected owned-browser close is reported and the browser stays owned (real Chromium)', async () => {
  const service = new FetchService(options);
  const state = internals(service);
  const browser = await state.getBrowser();
  const originalClose = browser.close.bind(browser);
  let restored = false;
  try {
    browser.close = (async () => { throw new Error('injected close rejection'); }) as never;
    await assert.rejects(service.close(), /BROWSER_CLOSE_UNCONFIRMED/);
    assert.equal(browser.isConnected(), true, 'the injected rejection did not stop the real browser');
    assert.equal(state.unconfirmedBrowser, browser, 'ownership of the still-connected browser is retained for diagnosis/retry');
    assert.equal(state.closingBrowsers.size, 0);
    await assert.rejects(service.close(), /BROWSER_CLOSE_UNCONFIRMED/, 'a repeated close stays truthful');
  } finally {
    browser.close = originalClose as never; restored = true;
    await originalClose();
  }
  assert.equal(restored && browser.isConnected(), false, 'test cleanup closed the real browser');
});
