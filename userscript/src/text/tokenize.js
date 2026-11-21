/**
 * Text fingerprints & similarity - all local, no tokens spent.
 *
 * tokenize() is MIRRORED in server/src/rta_server/claimsig.py; both are checked
 * against spec/canonical-vectors.json.
 */
import { safeUrl } from '../core/util.js';

export const STOP = new Set(('a an the and or but if of to in on at by for from with about as into onto over under after before than then so such ' +
  'that this these those there here it its is are was were be been being am do does did doing have has had having will would shall should ' +
  'can could may might must i me my mine we us our you your he him his she her they them their what which who whom whose when where why how ' +
  'all any each both few more most other some just very really also only own same too up down out off again once via amp says said ' +
  'according report reports reported breaking update lol omg guys anyone').split(' '));
export const NEG = new Set(['not', 'no', 'never', 'none', 'nor', 'without', 'cannot', 'nobody', 'nothing', 'neither']);
export const isNumTok = (w) => /\d/.test(w);
const stem = (w) => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(ing|ed)$/, '') : w).replace(/([^s])s$/, '$1');

/**
 * Normalised, ordered, de-duplicated bag of words. Numbers keep their value
 * ("380,000" -> "380000", "1.5%"); contractions become explicit negations
 * ("didn't" -> "did not") so they can be guarded.
 * @returns {Set<string>}
 */
export function tokenize(text, cap = 48) {
  const out = new Set();
  const s = String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d)[,\u00a0](?=\d{3}\b)/g, '$1')
    .replace(/n['’]t\b/g, ' not')
    .replace(/['’](s|re|ve|ll|d|m)\b/g, '');
  for (let w of s.split(/[^a-z0-9.%]+/)) {
    w = w.replace(/^\.+|\.+$/g, '');
    if (!w || STOP.has(w)) continue;
    if (!isNumTok(w)) {
      if (w.length < 2) continue;
      w = stem(w);
    }
    out.add(w);
    if (out.size >= cap) break;
  }
  return out;
}

/** Fingerprint of a post: title + start of the body. */
export const postTokens = (p) => tokenize(`${p.title || ''} ${String(p.body || '').slice(0, 600)}`);

/**
 * Jaccard similarity with guards: numbers and negation must agree, and very
 * short texts only match exactly - "inflation fell to 1%" never matches "… 3%".
 */
export function similarity(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const j = inter / (a.size + b.size - inter);
  if (j === 1) return 1;
  if (Math.min(a.size, b.size) < 4) return 0;
  for (const x of a) if (isNumTok(x) && !b.has(x)) return 0;
  for (const x of b) if (isNumTok(x) && !a.has(x)) return 0;
  const negA = [...a].some((x) => NEG.has(x)), negB = [...b].some((x) => NEG.has(x));
  return negA === negB ? j : 0;
}

/** Canonical form of a linked URL (drops tracking params, www/m./amp, youtu.be, trailing slash). '' for reddit links. */
export function urlKey(u) {
  const s = safeUrl(u);
  if (!s) return '';
  const x = new URL(s);
  let host = x.hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, '');
  if (/(^|\.)(reddit\.com|redd\.it|redditmedia\.com)$/.test(host)) return '';
  if (host === 'youtu.be') { x.searchParams.set('v', x.pathname.slice(1)); x.pathname = '/watch'; host = 'youtube.com'; }
  for (const k of [...x.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|igshid|mc_|cmp|ref|ref_src|share|si$|s$|source|feature|smid|taid)/i.test(k)) x.searchParams.delete(k);
  }
  x.searchParams.sort();
  const path = x.pathname.replace(/\/amp\/?$/i, '').replace(/\/+$/, '');
  const q = x.searchParams.toString();
  return host + path + (q ? `?${q}` : '');
}
