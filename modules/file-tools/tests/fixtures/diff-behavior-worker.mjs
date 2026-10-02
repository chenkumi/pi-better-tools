import { parentPort, workerData } from "node:worker_threads";

const validResult = { type: "result", diff: "-1 old\n+1 new", patch: "test patch", firstChangedLine: 1 };
const busy = () => {
  if (workerData.ready) Atomics.store(new Int32Array(workerData.ready), 0, 1);
  while (true) { /* Deliberately non-cooperative: only parent termination can stop this. */ }
};

switch (workerData.behavior) {
  case "busy":
    busy();
    break;
  case "exit-zero":
    process.exit(0);
    break;
  case "exit-nonzero":
    process.exit(7);
    break;
  case "throw":
    throw new Error("Intentional worker startup/runtime failure");
  case "resource-error":
    // Deterministic classification injection, not an actual host-memory exhaustion test.
    throw Object.assign(new Error("Injected worker memory-limit error"), { code: "ERR_WORKER_OUT_OF_MEMORY" });
  case "invalid":
    parentPort.postMessage(workerData.message);
    setInterval(() => {}, 1_000);
    break;
  case "result-then-busy":
    parentPort.postMessage(validResult);
    busy();
    break;
  case "duplicate-result":
    parentPort.postMessage(validResult);
    parentPort.postMessage({ type: "error", code: "IO_ERROR" });
    setInterval(() => {}, 1_000);
    break;
  default:
    throw new Error("Unknown fixture behavior");
}
