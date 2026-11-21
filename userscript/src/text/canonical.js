/**
 * Canonical claims ("rta.claim/1") and proposition keys.
 *
 * MIRROR OF server/src/rta_server/claimsig.py - both implementations are
 * checked against spec/canonical-vectors.json. A proposition key ignores
 * polarity, so posts spreading and debunking the same claim share a key and
 * differ only in `stance`.
 */
import { tokenize, NEG, isNumTok } from './tokenize.js';
import { squash, truncate } from '../core/util.js';

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
export const TOPICS = ['health', 'politics', 'science', 'economy', 'immigration', 'technology', 'environment', 'crime', 'conflict', 'elections', 'celebrity', 'other'];

/** Deterministic number formatting shared with the server. */
export function fmtNumber(v) {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'string') {
    let t = v.trim().replace(/[,\u00a0]/g, '');
    if (t.endsWith('%')) t = t.slice(0, -1);
    if (!NUMBER_RE.test(t)) return null;
    v = parseFloat(t);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const r = Math.floor(v * 1e6 + 0.5) / 1e6;
  const s = r.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One-way hash used for post ids and link keys sent to the community server. */
export const hashRef = async (v) => (await sha256hex(`rta1:${v}`)).slice(0, 32);

/**
 * Proposition key + stance for a canonical claim.
 * @returns {Promise<{key:string, stance:'affirms'|'denies', canonical:string, tokens:string[], sentence:string}|null>}
 */
export async function canonicalize(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  let neg = 0;
  const nums = new Set();
  const fld = (x) => {
    const kept = [];
    for (const t of tokenize(x == null ? '' : x, 32)) {
      if (NEG.has(t)) neg++;
      else if (isNumTok(t)) { const n = fmtNumber(t.replace(/%+$/, '')); nums.add(n != null ? n : t); }
      else kept.push(t);
    }
    return [...new Set(kept)].sort();
  };
  const s = fld(c.subject), p = fld(c.predicate), o = fld(c.object);
  if (!s.length && !o.length) return null;
  for (const q of (Array.isArray(c.quantities) ? c.quantities : []).slice(0, 8)) {
    const n = fmtNumber(q && typeof q === 'object' && !Array.isArray(q) ? q.value : q);
    if (n != null) nums.add(n);
  }
  const ctx = [...new Set([...fld(c.time), ...fld(c.place)])].sort();
  let stance = String(c.polarity || '').toLowerCase().startsWith('den') ? 'denies' : 'affirms';
  if (neg % 2) stance = stance === 'denies' ? 'affirms' : 'denies';
  const numList = [...nums].sort();
  const canonical = `s=${s.join(' ')}|p=${p.join(' ')}|o=${o.join(' ')}|n=${numList.join(' ')}|c=${ctx.join(' ')}`;
  const key = `p1_${(await sha256hex(canonical)).slice(0, 32)}`;
  const tokens = [...new Set([...s, ...p, ...o, ...ctx])].sort().concat(numList);
  const sentence = ['subject', 'predicate', 'object'].map((k) => String(c[k] || '').trim()).join(' ').trim().slice(0, 300);
  return { key, stance, canonical, tokens, sentence };
}

/** Keep only the documented (publishable) fields of the model's canonical object. */
export function cleanCanonical(c) {
  if (!c || typeof c !== 'object') return null;
  const t = (v, n) => (v == null ? null : truncate(squash(String(v)), n) || null);
  return {
    subject: t(c.subject, 200) || '',
    predicate: t(c.predicate, 80) || '',
    object: t(c.object, 300) || '',
    polarity: String(c.polarity || '').toLowerCase().startsWith('den') ? 'denies' : 'affirms',
    quantities: (Array.isArray(c.quantities) ? c.quantities : []).slice(0, 8)
      .map((q) => (q && typeof q === 'object' ? { value: typeof q.value === 'number' ? q.value : t(q.value, 30), unit: t(q.unit, 40) } : null))
      .filter((q) => q && q.value != null),
    time: t(c.time, 40),
    place: t(c.place, 80),
    topic: TOPICS.includes(String(c.topic)) ? c.topic : 'other',
  };
}

/** Model output -> { fields, key, stance, tokens, sentence } (stored on results as `canon`). */
export async function buildCanon(raw) {
  const fields = cleanCanonical(raw);
  const c = fields && await canonicalize(fields);
  return c ? { fields, key: c.key, stance: c.stance, tokens: c.tokens, sentence: c.sentence } : null;
}
