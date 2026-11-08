// Minimal Workers runtime shims so the Worker can run under Node for tests.
export function makeKV() {
  const store = new Map();
  let writes = 0;
  return {
    store,
    get writes() { return writes; },
    async get(k, type) {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { writes++; store.set(k, v); },
  };
}

export function installCaches() {
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
}

export function makeCtx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(p); }, async drain() { await Promise.all(pending); } };
}
