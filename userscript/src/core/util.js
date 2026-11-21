/** Small, dependency-free helpers. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day, YYYY-MM-DD (used for daily spend). */
export const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** UTC calendar day, YYYY-MM-DD (used in community reports). */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export const clampNum = (v, lo, hi, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** Coerce anything the model returns into a trimmed string. */
export const str = (v) => (typeof v === 'string' ? v : v == null ? '' : Array.isArray(v) ? v.map(str).join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();
export const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const asBool = (v) => v === true || v === 'true' || v === 1 || v === 'yes';

const base = () => (typeof location !== 'undefined' ? location.href : 'https://www.reddit.com/');
/** Absolute http(s) URL or null - never javascript:, data: etc. */
export const safeUrl = (u) => { try { const x = new URL(u, base()); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (_) { return null; } };
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

export function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** Runs fn at most once per `ms`, with a trailing call if it was requested meanwhile. */
export function throttle(fn, ms) {
  let t = null, pending = false;
  return function throttled() {
    if (t) { pending = true; return; }
    fn();
    t = setTimeout(function tick() { t = null; if (pending) { pending = false; fn(); t = setTimeout(tick, ms); } }, ms);
  };
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function parseJsonLoose(s) {
  const t = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* ignore */ } }
  throw new Error('Could not parse the JSON response');
}

/** Human-readable message from an API error response ({ status, text }). */
export function apiErrorMessage(res) {
  try {
    const j = JSON.parse(res.text);
    return str((j.error && (j.error.message || j.error)) || j.detail || j.message || res.text).slice(0, 300);
  } catch (_) { return squash(res.text).slice(0, 200) || `HTTP ${res.status}`; }
}
