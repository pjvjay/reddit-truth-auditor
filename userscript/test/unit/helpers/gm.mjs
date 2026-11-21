/**
 * Fake userscript-manager API for unit tests: in-memory GM storage and a
 * scriptable GM_xmlhttpRequest. Import this BEFORE any module under test.
 */
export const store = new Map();
export const requests = [];
let responder = () => ({ status: 404, text: '{}' });

globalThis.GM_getValue = (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d);
globalThis.GM_setValue = (k, v) => { store.set(k, structuredClone(v)); };
globalThis.GM_deleteValue = (k) => { store.delete(k); };
globalThis.GM_listValues = () => [...store.keys()];
globalThis.GM_xmlhttpRequest = (o) => {
  requests.push({ method: o.method, url: o.url, headers: o.headers, body: o.data ? JSON.parse(o.data) : null });
  Promise.resolve().then(async () => {
    const r = await responder(o);
    if (r.network) o.onerror();
    else o.onload({ status: r.status, responseText: typeof r.text === 'string' ? r.text : JSON.stringify(r.json ?? {}) });
  });
};

/** fn(request) -> { status, json } | { network: true } */
export function respond(fn) { responder = fn; }

export function resetGM() {
  store.clear();
  requests.length = 0;
  responder = () => ({ status: 404, text: '{}' });
}

/** Wait for queued microtasks / promise chains. */
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
