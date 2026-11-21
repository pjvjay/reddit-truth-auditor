/**
 * Local copy of the community's knowledge: the feed of agreed mistruths (matched
 * on-device, so the server never learns what the user reads) and the latest
 * narrative clusters. Both are persisted, so they keep working offline.
 */
import { storage } from '../core/env.js';
import { settings, KEYS, dupThreshold } from '../core/settings.js';
import { emit } from '../core/events.js';
import { log } from '../core/logger.js';
import { str, clampNum, safeUrl } from '../core/util.js';
import { similarity, urlKey } from '../text/tokenize.js';
import { hashRef } from '../text/canonical.js';
import { api } from './api.js';
import { communityConfigured, minClients, setCommunityStatus } from './config.js';

const num = (v, lo, hi, d) => clampNum(v, lo, hi, d);
const int = (v) => parseInt(v, 10) || 0;

/** Validate + slim one feed item (the server is not blindly trusted). */
function sanitizeItem(it) {
  if (!it || !/^p1_[0-9a-f]{32}$/.test(it.key)) return null;
  const c = it.consensus || {}, cl = it.cluster;
  return {
    key: it.key,
    aliases: (it.aliases || []).filter((a) => /^p1_[0-9a-f]{32}$/.test(a)).slice(0, 50),
    sentence: str(it.sentence).slice(0, 300),
    claim: it.claim && typeof it.claim === 'object' ? it.claim : null,
    tokens: (it.tokens || []).slice(0, 64).map(String),
    url_hashes: (it.url_hashes || []).filter((u) => /^[0-9a-f]{32}$/.test(u)).slice(0, 100),
    consensus: {
      status: str(c.status), prop_truth: num(c.prop_truth, 0, 10, 5), n_clients: int(c.n_clients), agreement: num(c.agreement, 0, 1, 0),
      confidence: ['low', 'medium', 'high'].includes(c.confidence) ? c.confidence : 'medium', verdict: str(c.verdict).slice(0, 400),
      sources: (c.sources || []).map(String).filter((u) => safeUrl(u)).slice(0, 5),
    },
    counts: { posts: int((it.counts || {}).posts), spreading: int((it.counts || {}).spreading), debunking: int((it.counts || {}).debunking) },
    cluster: cl && /^c_[0-9a-f]{6,40}$/.test(cl.id) ? {
      id: cl.id, label: str(cl.label).slice(0, 300), severity: num(cl.severity, 0, 100, 0), share: num(cl.share, 0, 1, 0),
      independent_sources: int(cl.independent_sources), outlets: (cl.outlets || []).slice(0, 5).map((o) => str(o).slice(0, 60)),
      spreading_posts: int(cl.spreading_posts), subreddit_count: int(cl.subreddit_count), growth: num(cl.growth, -1, 1000, 0),
    } : null,
  };
}

class Knowledge {
  constructor() {
    this.items = [];
    this.byKey = new Map(); // proposition key / alias -> item
    this.byUrl = new Map(); // hashed link key -> item
    this.syncedAt = 0;
    this.syncing = null;
  }

  load() {
    const raw = storage.get(KEYS.feed, null);
    this.index(raw && Array.isArray(raw.items) ? raw.items : [], raw ? raw.syncedAt || 0 : 0);
    return this;
  }

  index(items, syncedAt) {
    this.items = items;
    this.syncedAt = syncedAt;
    this.byKey = new Map();
    this.byUrl = new Map();
    for (const it of items) {
      it._tokens = new Set(it.tokens || []);
      this.byKey.set(it.key, it);
      for (const a of it.aliases || []) this.byKey.set(a, it);
      for (const u of it.url_hashes || []) this.byUrl.set(u, it);
    }
  }

  /** Use community verdicts? (joined, enabled, and a list is available - possibly cached from earlier). */
  usable() { return communityConfigured() && settings.useCommunity && this.items.length > 0; }
  has(key) { return !!(key && this.byKey.has(key)); }
  clusterOf(key) { const it = key && this.byKey.get(key); return (it && it.cluster) || null; }
  trusted(it) { return !!it && it.consensus.n_clients >= minClients() && it.consensus.status === 'false'; }

  /** Download the feed when stale (or forced). Failures keep the cached copy. */
  sync(force = false) {
    if (!communityConfigured()) return Promise.resolve(null);
    if (this.syncing) return this.syncing;
    const hours = Math.max(0.25, Number(settings.communitySyncHours) || 6);
    if (!force && Date.now() - this.syncedAt < hours * 3600e3) return Promise.resolve(null);
    this.syncing = (async () => {
      try {
        const j = await api.feed(minClients());
        const items = (Array.isArray(j.items) ? j.items : []).map(sanitizeItem).filter(Boolean);
        const now = Date.now();
        storage.set(KEYS.feed, { syncedAt: now, items });
        this.index(items, now);
        setCommunityStatus({ lastSync: now, syncError: null });
        log('community feed synced:', items.length);
        emit('community:feed', this);
      } catch (e) {
        setCommunityStatus({ syncError: e.message });
        log('community sync failed (keeping cached list)', e.message);
      } finally {
        this.syncing = null;
        emit('community:changed');
      }
    })();
    return this.syncing;
  }

  /** Free, pre-extraction match: the linked article is known to spread an agreed mistruth. */
  async matchLink(post) {
    if (!this.usable()) return null;
    const uk = urlKey(post.url);
    if (!uk) return null;
    const it = this.byUrl.get(await hashRef(uk));
    return this.trusted(it) ? { item: it, via: 'link', sim: 1 } : null;
  }

  /** After extraction: exact proposition key (incl. server-side aliases), then fuzzy token match. */
  matchCanon(canon) {
    if (!this.usable() || !canon) return null;
    const exact = this.byKey.get(canon.key);
    if (this.trusted(exact)) return { item: exact, via: 'key', sim: 1 };
    const mine = new Set(canon.tokens);
    const thr = dupThreshold();
    let best = null;
    for (const it of this.items) {
      if (!this.trusted(it)) continue;
      const sim = similarity(mine, it._tokens);
      if (sim >= thr && (!best || sim > best.sim)) best = { item: it, via: 'fuzzy', sim };
    }
    return best;
  }

  /**
   * Community narrative clusters. Returns { items, at, stale, error }: fresh data when the
   * server is reachable, otherwise the last cached copy (stale: true).
   */
  async trends(force = false) {
    const cached = storage.get(KEYS.trends, null);
    const fresh = cached && Date.now() - cached.at < 10 * 60e3;
    if (!communityConfigured()) return { items: cached ? cached.items : [], at: cached ? cached.at : 0, stale: true, error: 'Community not connected' };
    if (!force && fresh) return { items: cached.items, at: cached.at, stale: false, error: null };
    try {
      const j = await api.clusters(25);
      const items = (Array.isArray(j.items) ? j.items : []).slice(0, 25);
      storage.set(KEYS.trends, { at: Date.now(), items });
      return { items, at: Date.now(), stale: false, error: null };
    } catch (e) {
      return { items: cached ? cached.items : [], at: cached ? cached.at : 0, stale: true, error: e.message };
    }
  }
}

export const knowledge = new Knowledge();
