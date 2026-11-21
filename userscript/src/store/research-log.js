/**
 * Research log - the local source of truth.
 *
 * Every analysed post is stored under its own key (`rta.log.<t3_id>` -> { t, r })
 * plus a compact index entry used for duplicate matching, the History tab, CSV
 * export and offline publishing. Works entirely without network access; the
 * community publisher reads pending entries from here whenever it can.
 *
 * Publish state (`ps`) per entry:
 *   0 NONE      not publishable (accurate, joke, no canonical claim, legacy)
 *   1 PENDING   waiting to be shared with the community server (also while the
 *               server's daily quota is used up - those are sent after it resets)
 *   2 SENT      accepted by the server
 *   3 REJECTED  refused by the server as invalid - never retried automatically
 */
import { storage } from '../core/env.js';
import { settings, KEYS, dupThreshold } from '../core/settings.js';
import { emit } from '../core/events.js';
import { truncate, throttle } from '../core/util.js';
import { log } from '../core/logger.js';
import { tokenize, postTokens, similarity, urlKey } from '../text/tokenize.js';
import { toneSignals, toneClass, toneOf, isNonLiteral } from '../text/tone.js';

export const PUBLISH = Object.freeze({ NONE: 0, PENDING: 1, SENT: 2, REJECTED: 3 });

/** Index entry layout (stored as arrays to keep the index small). Append-only - never reorder. */
const FIELDS = [
  't', //     write time (ms)
  'kind', //  'a' audit | 's' skip
  'risk', //  literal risk 0-100 (-1 for skips)
  'title', // post title (truncated)
  'sub', //   subreddit
  'tt', //    post text tokens (space separated)
  'ct', //    claim tokens
  'url', //   normalised link key
  'dup', //   id this result was reused from
  'sat', //   satire score
  'fr', //    tone framing: literal | sarcasm | humour | satire-venue | satire-link
  'tc', //    tone class: l | n | f
  'ts', //    1 = skipped as evident satire/joke
  'pk', //    canonical proposition key
  'st', //    stance a | d
  'cm', //    1 = verdict came from the community list
  'ps', //    publish state (PUBLISH)
];
const DEFAULT_META = { title: '', sub: '', tt: '', ct: '', url: '', dup: '', sat: 0, fr: 'literal', ts: 0, pk: '', st: '', cm: 0, ps: PUBLISH.NONE };

class ResearchLog {
  constructor() {
    this.idx = null; //           Map<id, meta>
    this.deleted = new Set();
    this.dirty = false;
    this.saveSoon = () => { this.dirty = true; this._throttledSave(); };
    this._throttledSave = throttle(() => this.flush(), 1000);
  }

  /** Persist on page hide so a navigation can never lose index entries. */
  init() {
    this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
    }
    return this;
  }

  ttl() { return Math.max(0.1, Number(settings.logDays) || 30) * 864e5; }
  max() { return Math.max(100, parseInt(settings.maxLogEntries, 10) || 5000); }

  // ---------------------------------------------------------------- encoding
  decode(raw) {
    const m = new Map();
    if (!raw || typeof raw !== 'object') return m;
    for (const [id, a] of Object.entries(raw)) {
      if (!Array.isArray(a)) continue;
      const e = { ...DEFAULT_META };
      FIELDS.forEach((f, i) => { if (a[i] != null && a[i] !== '') e[f] = a[i]; });
      if (a[11] == null) e.tc = e.kind === 'a' ? (e.sat >= (Number(settings.satireCutoff) || 7) ? 'n' : 'l') : ''; // pre-1.2
      m.set(id, e);
    }
    return m;
  }

  encode() {
    const o = {};
    for (const [id, m] of this.idx) o[id] = FIELDS.map((f) => m[f]);
    return o;
  }

  /** Lazily materialised token set of an index entry. */
  tokens(m, field) {
    const k = `_${field}`;
    if (!m[k]) m[k] = new Set(m[field] ? m[field].split(' ') : []);
    return m[k];
  }

  meta(r, t, post, ps = PUBLISH.NONE) {
    const p = post || r.post || {};
    return {
      t,
      kind: r.kind === 'audit' ? 'a' : 's',
      risk: r.kind === 'audit' ? r.risk : -1,
      sat: r.kind === 'audit' ? r.sarcasm : 0,
      title: truncate(String(p.title || ''), 160),
      sub: p.subreddit || '',
      tt: [...postTokens(p)].join(' '),
      ct: r.claim ? [...tokenize(r.claim)].join(' ') : '',
      url: urlKey(p.url),
      dup: (r.dupOf && r.dupOf.id) || '',
      fr: toneSignals(p).frame,
      tc: r.kind === 'audit' ? toneClass(toneOf(r), r.presentedAsFact) : r.toneSkip ? 'n' : '',
      ts: r.toneSkip ? 1 : 0,
      pk: (r.canon && r.canon.key) || '',
      st: r.canon ? (r.canon.stance === 'denies' ? 'd' : 'a') : '',
      cm: r.community ? 1 : 0,
      ps,
    };
  }

  // ---------------------------------------------------------------- lifecycle
  load() {
    if (this.idx) return this;
    this.idx = this.decode(storage.get(KEYS.index, {}));
    this.migrateLegacyCache();
    this.reconcile();
    this.prune();
    return this;
  }

  /** v1.0 kept a single 24 h blob under 'rta.cache' - fold it into the log once. */
  migrateLegacyCache() {
    const old = storage.get(KEYS.legacyCache, null);
    if (!old || typeof old !== 'object') return;
    for (const [id, e] of Object.entries(old)) {
      if (e && e.r && !this.idx.has(id)) {
        storage.set(KEYS.logPrefix + id, { t: e.t, r: e.r });
        this.idx.set(id, this.meta(e.r, e.t, e.r.post));
      }
    }
    storage.remove(KEYS.legacyCache);
    this.saveIndex();
  }

  /** Self-heal: records whose index entry was never written (tab closed mid-save, other tabs). */
  reconcile() {
    const keys = storage.keys();
    if (!keys) return;
    let added = 0;
    for (const k of keys) {
      if (!k.startsWith(KEYS.logPrefix)) continue;
      const id = k.slice(KEYS.logPrefix.length);
      if (this.idx.has(id)) continue;
      const rec = storage.get(k, null);
      if (rec && rec.r) { this.idx.set(id, this.meta(rec.r, rec.t, null, rec.ps || PUBLISH.NONE)); added++; }
    }
    if (added) { log('reconciled', added, 'log entries'); this.saveIndex(); }
  }

  prune() {
    const now = Date.now(), ttl = this.ttl(), max = this.max();
    const sorted = [...this.idx.entries()].sort((a, b) => b[1].t - a[1].t);
    let changed = false;
    sorted.forEach(([id, m], i) => {
      if (i >= max || now - m.t > ttl) {
        storage.remove(KEYS.logPrefix + id);
        this.idx.delete(id);
        this.deleted.add(id);
        changed = true;
      }
    });
    if (changed) this.saveSoon();
  }

  flush() { if (this.dirty) this.saveIndex(); }

  /** Take over what other tabs wrote meanwhile (newest entry wins; same entry -> most advanced publish state). */
  mergeStored() {
    for (const [id, m] of this.decode(storage.get(KEYS.index, {}))) {
      if (this.deleted.has(id)) continue;
      const cur = this.idx.get(id);
      if (!cur || cur.t < m.t) this.idx.set(id, m);
      else if (cur.t === m.t && m.ps > cur.ps) cur.ps = m.ps;
    }
  }

  /**
   * Catch up with other tabs without writing anything. The publisher calls this
   * before it chooses what to send, so a report another tab has already sent is
   * not sent again from this tab's older copy of the index.
   */
  refresh() {
    this.load();
    this.mergeStored();
  }

  /** Merge with what other tabs wrote meanwhile, then persist. */
  saveIndex() {
    this.mergeStored();
    this.deleted.clear();
    this.dirty = false;
    storage.set(KEYS.index, this.encode());
  }

  // ---------------------------------------------------------------- records
  get(id) {
    this.load();
    const rec = storage.get(KEYS.logPrefix + id, null);
    if (!rec || !rec.r) {
      if (this.idx.has(id)) { this.idx.delete(id); this.saveSoon(); }
      return null;
    }
    if (Date.now() - rec.t > this.ttl()) { this.remove(id); return null; }
    if (!this.idx.has(id)) { this.idx.set(id, this.meta(rec.r, rec.t, null, rec.ps || PUBLISH.NONE)); this.saveSoon(); } // written by another tab
    return rec.r;
  }

  /**
   * Store a result. `publishable` marks it PENDING for the community publisher -
   * regardless of whether the community is configured or reachable right now.
   */
  put(id, r, post, { publishable = false } = {}) {
    this.load();
    const t = Date.now();
    const ps = publishable ? PUBLISH.PENDING : PUBLISH.NONE;
    storage.set(KEYS.logPrefix + id, { t, r, ps });
    this.idx.set(id, this.meta(r, t, post, ps));
    this.deleted.delete(id);
    if (this.idx.size > this.max() + 50) this.prune();
    this.saveSoon();
    emit('log:changed');
  }

  remove(id) {
    this.load();
    storage.remove(KEYS.logPrefix + id);
    this.idx.delete(id);
    this.deleted.add(id);
    this.saveSoon();
    emit('log:changed');
  }

  clear() {
    this.load();
    const keys = (storage.keys() || [...this.idx.keys()].map((id) => KEYS.logPrefix + id)).filter((k) => k.startsWith(KEYS.logPrefix));
    for (const k of keys) storage.remove(k);
    this.idx = new Map();
    this.deleted.clear();
    storage.set(KEYS.index, {});
    emit('log:changed');
  }

  size() { return this.load().idx.size; }

  /** [id, meta] pairs, newest first. */
  entries() { return [...this.load().idx.entries()].sort((a, b) => b[1].t - a[1].t); }

  // ---------------------------------------------------------------- publishing (offline-first)
  /** Oldest pending entries first: [[id, meta], ...]. */
  pending(limit = Infinity) {
    const out = [...this.load().idx.entries()].filter(([, m]) => m.ps === PUBLISH.PENDING).sort((a, b) => a[1].t - b[1].t);
    return out.slice(0, limit);
  }

  pendingCount() { let n = 0; for (const m of this.load().idx.values()) if (m.ps === PUBLISH.PENDING) n++; return n; }

  setPublishState(ids, ps) {
    this.load();
    for (const id of ids) {
      const m = this.idx.get(id);
      if (!m) continue;
      m.ps = ps;
      const rec = storage.get(KEYS.logPrefix + id, null);
      if (rec) storage.set(KEYS.logPrefix + id, { ...rec, ps });
    }
    this.saveIndex();
    emit('community:changed');
  }

  /** Mark an existing entry pending (e.g. its proposition just appeared on the community list). */
  markPending(id) {
    const m = this.load().idx.get(id);
    if (m && m.ps === PUBLISH.NONE) this.setPublishState([id], PUBLISH.PENDING);
  }

  discardPending() { this.setPublishState(this.pending().map(([id]) => id), PUBLISH.NONE); }

  // ---------------------------------------------------------------- duplicate detection
  /**
   * Candidates must share the post's framing: "5G spreads the virus /s" must never
   * inherit the verdict of the sincere post with the same words.
   */
  usable(m, frame) {
    if ((m.fr || 'literal') !== frame) return false;
    if (m.ts && !settings.ignoreSatire) return false; // satire that was never audited can't stand in for an audit
    return true;
  }

  /** Tier 1 (free): crosspost of / same link as / near-identical text to a logged post. */
  findSimilarPost(post) {
    this.load();
    const frame = toneSignals(post).frame;
    const xp = post.crosspostParent && this.idx.get(post.crosspostParent);
    if (xp && post.crosspostParent !== post.id && this.usable(xp, frame)) return { id: post.crosspostParent, via: 'crosspost', sim: 1 };
    const thr = dupThreshold();
    const tt = postTokens(post), uk = urlKey(post.url);
    let best = null;
    for (const [id, m] of this.idx) {
      if (id === post.id || !this.usable(m, frame)) continue;
      const sim = similarity(tt, this.tokens(m, 'tt'));
      let via = null;
      if (uk && m.url === uk && sim >= Math.min(0.5, thr)) via = 'link';
      else if (sim >= thr) via = 'text';
      if (via && (!best || sim > best.sim)) best = { id, via, sim };
    }
    return best;
  }

  /** Tier 2a: same canonical proposition already audited (either stance). */
  findProposition(key, selfId, tc) {
    if (!key) return null;
    let best = null;
    for (const [id, m] of this.load().idx) {
      if (id === selfId || m.kind !== 'a' || m.pk !== key || m.tc !== tc || m.cm) continue;
      if (!best || (!m.dup && best.dup) || m.t > best.t) best = { id, via: 'proposition', sim: 1, dup: !!m.dup, t: m.t };
    }
    return best;
  }

  /** Tier 2b: lexically equivalent claim already audited (same tone class). */
  findSimilarClaim(claim, selfId, tc) {
    const ct = tokenize(claim);
    const thr = dupThreshold();
    let best = null;
    for (const [id, m] of this.load().idx) {
      if (id === selfId || m.kind !== 'a' || !m.ct || m.tc !== tc) continue;
      const sim = similarity(ct, this.tokens(m, 'ct'));
      if (sim >= thr && (!best || sim > best.sim)) best = { id, via: 'claim', sim };
    }
    return best;
  }

  /** Loosely related audited claims, offered to the extraction model for a semantic "same claim?" judgement. */
  claimCandidates(post, n = 5) {
    const tt = postTokens(post);
    if (tt.size < 3) return [];
    const scored = [];
    for (const [id, m] of this.load().idx) {
      if (id === post.id || m.kind !== 'a' || !m.ct || m.dup) continue;
      const a = this.tokens(m, 'tt'), c = this.tokens(m, 'ct');
      let i1 = 0, i2 = 0;
      for (const x of tt) { if (a.has(x)) i1++; if (c.has(x)) i2++; }
      const score = Math.max(i1 / (tt.size + a.size - i1), i2 / Math.min(tt.size, c.size || 1));
      if (score >= 0.25) scored.push({ id, score });
    }
    return scored.sort((x, y) => y.score - x.score).slice(0, n)
      .map(({ id }) => {
        const r = this.get(id);
        if (!r || r.kind !== 'audit' || !r.claim) return null;
        const t = toneOf(r);
        const toneLabel = t === 'sarcastic' ? 'sincere meaning of a sarcastic post'
          : isNonLiteral(r) ? `${t}${r.presentedAsFact ? ', passed off as fact' : ', not meant as fact'}` : 'sincere';
        return { id, claim: r.claim, tc: toneClass(t, r.presentedAsFact), toneLabel };
      })
      .filter(Boolean);
  }
}

/** The singleton research log. */
export const researchLog = new ResearchLog();
