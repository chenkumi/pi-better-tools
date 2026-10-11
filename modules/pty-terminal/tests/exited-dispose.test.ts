import assert from "node:assert/strict";
import test from "node:test";
import { PtySessionManager } from "../src/pty-manager.ts";

for (const platform of ["linux", "win32"] as const) {
  for (const route of ["kill", "retention", "capacity", "shutdown"] as const) {
    test(`R4: ${platform} exited disposal via ${route}`, async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      const signals: Array<string | undefined> = [];
      let exit!: () => void;
      let now = 0;
      // No real process or native PTY: the counter records backend calls only.
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      try {
        const manager = new PtySessionManager({
          maxSessions: 1, exitedRetentionMs: 100, now: () => now,
          spawnPty: (() => ({ pid: 123, write() {}, resize() {},
            kill(signal?: string) { signals.push(signal); },
            onData() { return { dispose() {} }; },
            onExit(cb: (event: { exitCode: number }) => void) { exit = () => cb({ exitCode: 0 }); return { dispose() {} }; },
          })) as never,
        });
        const id = manager.spawn("fake", [], {}, process.cwd()).sessionId;
        exit();
        if (route === "kill") assert.equal((await manager.kill(id)).released, true);
        if (route === "retention") { now = 100; assert.deepEqual(manager.list(), []); }
        if (route === "capacity") assert.notEqual(manager.spawn("fake", [], {}, process.cwd()).sessionId, id);
        if (route === "shutdown") assert.deepEqual(await manager.shutdown(), { retained: [], errors: [] });
        assert.deepEqual(signals, platform === "win32" ? [undefined] : [],
          "POSIX exited PID must never be signalled; Windows native handle release remains required");
      } finally { Object.defineProperty(process, "platform", descriptor); }
    });
  }
}
