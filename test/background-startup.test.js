// The worker's startup list refresh and its cosmetic storage: a refresh cut off
// by Chrome stopping the worker is retried on the next start (a few times per
// session, not on every wake), and the per-frame cosMeta stays small.
import backgroundSource from "../src/general-background.js" with { type: "text" };
function assert(c, l) { if (!c) throw new Error(l); }

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function loadWorker({ store = {}, session = {}, listFetch }) {
  let startTimer = null;
  let onInstalled = null;
  const listener = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      id: EXT, lastError: undefined,
      getURL: (p) => "chrome-extension://" + EXT + "/" + p,
      onMessage: listener(), onStartup: listener(),
      onInstalled: { addListener(f) { onInstalled = f; } },
    },
    storage: {
      local: {
        get(keys, cb) { const out = {}; for (const k of [].concat(keys || [])) if (k in store) out[k] = structuredClone(store[k]); cb(out); },
        set(items, cb) { Object.assign(store, structuredClone(items)); if (cb) cb(); },
        remove(keys, cb) { for (const k of [].concat(keys)) delete store[k]; if (cb) cb(); },
      },
      session: {
        get(keys, cb) { const out = {}; for (const k of [].concat(keys || [])) if (k in session) out[k] = session[k]; cb(out); },
        set(items, cb) { Object.assign(session, items); if (cb) cb(); },
      },
      onChanged: listener(),
    },
    declarativeNetRequest: {
      getDynamicRules(cb) { cb([]); },
      updateDynamicRules(_o, cb) { if (cb) cb(); },
      updateEnabledRulesets(_o, cb) { if (cb) cb(); },
    },
    action: { setIcon(_o, cb) { if (cb) cb(); }, setTitle() {} },
  };
  const importScripts = (...names) => {
    for (const n of names) (0, eval)(Deno.readTextFileSync(new URL("../src/" + n, import.meta.url)));
  };
  const prefix = "chrome-extension://" + EXT + "/";
  const fetch = (url, init) => {
    if (url.startsWith(prefix)) return Promise.resolve(new Response(Deno.readTextFileSync(new URL("../" + url.slice(prefix.length), import.meta.url))));
    return listFetch(url, init);
  };
  const fakeSetTimeout = (fn) => { startTimer = fn; return 0; };
  new Function("chrome", "importScripts", "setTimeout", "fetch", backgroundSource)(chrome, importScripts, fakeSetTimeout, fetch);
  return { store, session, start: () => startTimer && startTimer(), installed: () => onInstalled && onInstalled({}) };
}

Deno.test("a startup refresh cut off part way is retried on the next worker start, at most 3 starts per session", async () => {
  const session = {};
  const store = { generalEnabled: true, generalAllowedOrigins: [] };
  const hung = [];
  let calls = 0;
  let stopped = false;
  // Every list download hangs: Chrome stops the worker before any finishes.
  const listFetch = () => {
    calls++;
    if (stopped) return Promise.reject(new TypeError("Failed to fetch"));
    return new Promise((_, reject) => hung.push(reject));
  };
  const perStart = [];
  for (let i = 0; i < 4; i++) {
    const w = loadWorker({ store, session, listFetch });
    const before = calls;
    w.start();
    await tick(300);
    perStart.push(calls - before);
  }
  assert(perStart.slice(0, 3).every((n) => n === 1), "starts 1-3 begin a refresh: " + perStart);
  assert(perStart[3] === 0, "4th start leaves it for the next session: " + perStart);
  assert(session.listRefreshTries === 3 && !session.listRefreshDone, JSON.stringify(session));
  // Let the abandoned runs finish so their abort timers are cleared.
  stopped = true;
  hung.splice(0).forEach((reject) => reject(new TypeError("Failed to fetch")));
  await tick(1500);
});

Deno.test("a startup refresh that finishes is not repeated in the same session", async () => {
  const session = {};
  const store = { generalEnabled: true, generalAllowedOrigins: [] };
  let calls = 0;
  const listFetch = () => { calls++; return Promise.reject(new TypeError("Failed to fetch")); };
  const w = loadWorker({ store, session, listFetch });
  w.start();
  for (let i = 0; i < 100 && !session.listRefreshDone; i++) await tick(20);
  assert(session.listRefreshDone === true && session.listRefreshTries === 1, JSON.stringify(session));
  const after = calls;
  loadWorker({ store, session, listFetch }).start();
  await tick(200);
  assert(calls === after, "no second download in this session");
});

Deno.test("cosMeta loses its key list on upgrade (every frame reads it); the list moves to cosKeys and still cleans up", async () => {
  const keys = ["cosG", "cosS:stale.example", "cosS:example.com"];
  const store = {
    generalEnabled: true, generalAllowedOrigins: [],
    cosMeta: { source: "bundled", packedAt: "old", keys },
    cosG: ".x", "cosS:stale.example": [".y"], "cosS:example.com": [".z"],
  };
  const w = loadWorker({ store, listFetch: () => Promise.reject(new TypeError("offline")) });
  w.installed();
  for (let i = 0; i < 100 && store.cosMeta.packedAt === "old"; i++) await tick(20);
  assert(store.cosMeta.packedAt !== "old", "bundled cosmetics re-seeded");
  assert(!("keys" in store.cosMeta), "cosMeta has no key list: " + Object.keys(store.cosMeta));
  assert(JSON.stringify(store.cosMeta).length < 200, "cosMeta is small: " + JSON.stringify(store.cosMeta).length);
  assert(Array.isArray(store.cosKeys) && store.cosKeys.length > 1000 && store.cosKeys.includes("cosG"), "cosKeys lists the written keys");
  assert(!("cosS:stale.example" in store), "keys from the old list that the new set lacks are removed");
});

Deno.test("an already-current install only has its cosMeta slimmed", async () => {
  const store = {
    generalEnabled: true, generalAllowedOrigins: [],
    cosMeta: { source: "refresh", updatedAt: 1, keys: ["cosG", "cosS:a.example"] },
    cosG: ".x", "cosS:a.example": [".y"],
  };
  const w = loadWorker({ store, listFetch: () => Promise.reject(new TypeError("offline")) });
  w.installed();
  for (let i = 0; i < 100 && !store.cosKeys; i++) await tick(20);
  assert(JSON.stringify(store.cosKeys) === '["cosG","cosS:a.example"]', JSON.stringify(store.cosKeys));
  assert(JSON.stringify(store.cosMeta) === '{"source":"refresh","updatedAt":1}', JSON.stringify(store.cosMeta));
  assert(store.cosG === ".x" && store["cosS:a.example"][0] === ".y", "refreshed rules untouched");
});
