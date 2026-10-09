import { parentPort } from 'node:worker_threads';
import { extractHtml } from './extract-core.mjs';

// Runs the synchronous JSDOM/Readability extraction off the main thread so the host event loop
// (TUI, abort handling, timeoutMs) stays responsive. The parent terminates this worker on abort
// and may reuse it for later jobs, because loading jsdom costs seconds per fresh worker.
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ html, url, format, mode }) => {
  try {
    parentPort.postMessage({ ok: true, result: extractHtml(html, url, format, mode) });
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
