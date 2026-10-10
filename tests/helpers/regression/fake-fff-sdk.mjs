// Offline injection at the @ff-labs/fff-node SDK boundary. pi-fff caches its SDK promise on globalThis.__fffSdkPromiseGlobal
// (documented in node_modules/@ff-labs/pi-fff/src/sdk.ts), so real pi-fff code, real FilePickerFactory and real AuxFinderPool
// run unmodified; only the native FileFinder.create() is replaced. No native DLL is needed or loaded.
export function installFakeFffSdk({ onCreate, gate } = {}) {
  const created = [];
  const ok = value => ({ ok: true, value });
  const FileFinder = {
    create(options) {
      const record = { basePath: options.basePath, destroyed: false, scanReleased: false };
      const scan = gate?.(record);
      const finder = {
        get isDestroyed() { return record.destroyed; },
        destroy() { record.destroyed = true; },
        async waitForScan() { await scan; record.scanReleased = true; return ok(true); },
        getScanProgress: () => ok({ isScanning: false, scannedFilesCount: 0 }),
        grep: () => ok({ items: [], totalMatched: 0, totalFilesSearched: 0, totalFiles: 0, filteredFileCount: 0, nextCursor: null }),
        fileSearch: () => ok({ items: [], scores: [], totalMatched: 0, totalFiles: 0 }),
        mixedSearch: () => ok({ items: [], scores: [], totalMatched: 0, totalFiles: 0 }),
      };
      record.finder = finder; created.push(record); onCreate?.(record);
      return ok(finder);
    },
  };
  const previous = globalThis.__fffSdkPromiseGlobal;
  globalThis.__fffSdkPromiseGlobal = Promise.resolve({ FileFinder });
  return { created, restore() { if (previous === undefined) delete globalThis.__fffSdkPromiseGlobal; else globalThis.__fffSdkPromiseGlobal = previous; } };
}
