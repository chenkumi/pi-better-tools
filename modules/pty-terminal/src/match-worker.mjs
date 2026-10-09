import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({ ready: true });
try {
  const matched = new RegExp(workerData.source, workerData.flags).test(workerData.input);
  parentPort.postMessage({ matched });
} catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
