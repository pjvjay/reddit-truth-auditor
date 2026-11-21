/**
 * The only module that touches the userscript manager's API (GM_*) or
 * page-level globals. Everything else imports from here, which keeps the
 * rest of the code testable in plain Node (tests install fakes on globalThis).
 */

const g = globalThis;

/** Persistent key/value storage shared by all tabs (Tampermonkey / Violentmonkey). */
export const storage = {
  get(key, fallback) { return g.GM_getValue(key, fallback); },
  set(key, value) { g.GM_setValue(key, value); },
  remove(key) {
    if (typeof g.GM_deleteValue === 'function') g.GM_deleteValue(key);
    else g.GM_setValue(key, null);
  },
  /** All keys, or null if the manager does not support listing. */
  keys() {
    try { return typeof g.GM_listValues === 'function' ? g.GM_listValues() : null; } catch (_) { return null; }
  },
};

/**
 * Cross-origin HTTP via GM_xmlhttpRequest: bypasses CORS, and the page itself
 * can never observe the request or its Authorization header.
 * Resolves with { status, text }; rejects only on network failure / timeout.
 */
export function httpRequest({ method = 'GET', url, headers = {}, data = null, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    const host = (() => { try { return new URL(url).hostname; } catch (_) { return url; } })();
    g.GM_xmlhttpRequest({
      method, url, headers, data, timeout,
      onload: (r) => resolve({ status: r.status, text: r.responseText || '' }),
      onerror: () => reject(Object.assign(new Error(`Network error contacting ${host}`), { network: true })),
      ontimeout: () => reject(Object.assign(new Error(`Request to ${host} timed out`), { network: true })),
      onabort: () => reject(Object.assign(new Error('Request aborted'), { network: true })),
    });
  });
}

export function addPageStyle(css) {
  if (typeof g.GM_addStyle === 'function') {
    try { g.GM_addStyle(css); return; } catch (_) { /* fall through */ }
  }
  const el = document.createElement('style');
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}

export function registerMenuCommand(label, fn) {
  if (typeof g.GM_registerMenuCommand === 'function') g.GM_registerMenuCommand(label, fn);
}

export const scriptVersion = () =>
  (typeof g.GM_info !== 'undefined' && g.GM_info.script && g.GM_info.script.version) || (typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev');

/** Whether the browser believes it is online (best effort; false negatives are possible). */
export const browserOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
