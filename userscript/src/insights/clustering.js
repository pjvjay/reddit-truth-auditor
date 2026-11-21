/**
 * Event clustering of propagating false claims - JS port of
 * server/src/rta_server/clustering.py (same weights, similarity and weighted
 * DBSCAN), used for the offline "My history" narratives in the Trends tab.
 *
 * Differences for a single user's history: falsity is weighted by the audit's
 * confidence instead of by independent reporters, and a narrative needs at
 * least `minPosts` posts (you have seen it spread), not just weight.
 */
import { tokenize, NEG, isNumTok } from '../text/tokenize.js';
import { fmtNumber } from '../text/canonical.js';
import { sourceWeight } from './outlets.js';

const FIELD_W = { subject: 1.5, object: 1.5, context: 1.0, predicate: 0.5, numbers: 0.3 };
const KINDS = ['news', 'opinion', 'analysis', 'video', 'social', 'blog'];
const IDF_PRIOR = 50;
const DAY = 864e5;

export const DEFAULT_CONFIG = Object.freeze({ simThreshold: 0.25, minMass: 2.0, minPosts: 2, diversityBias: 0.5, maxTruth: 5, timeTau: 7 });

/** Per-field tokens (mirror of claimsig.field_tokens). */
export function fieldTokens(c) {
  const out = { subject: [], predicate: [], object: [], context: [], numbers: [] };
  if (!c || typeof c !== 'object') return out;
  for (const [src, dst] of [['subject', 'subject'], ['predicate', 'predicate'], ['object', 'object'], ['time', 'context'], ['place', 'context']]) {
    for (const t of tokenize(c[src], 32)) {
      if (NEG.has(t)) continue;
      const n = isNumTok(t) ? fmtNumber(t.replace(/%+$/, '')) : null;
      if (n != null) out.numbers.push(n);
      else out[dst].push(t);
    }
  }
  for (const q of (Array.isArray(c.quantities) ? c.quantities : []).slice(0, 8)) {
    const n = fmtNumber(q && typeof q === 'object' ? q.value : q);
    if (n != null) out.numbers.push(n);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

const engagement = (p) => Math.max(0, p.score || 0) + 2 * Math.max(0, p.comments || 0) + 20 * Math.max(0, p.crossposts || 0);
export const reachOf = (posts) => Math.log1p(posts.reduce((s, p) => s + engagement(p), 0));

/** Independent-source diversity (ownership groups × tier, extra articles, article kinds). */
export function diversity(posts) {
  const groups = new Map(), outlets = new Map(), articles = new Set(), kinds = new Set();
  for (const p of posts) {
    if (!p.outlet_group) continue;
    const info = { tier: p.tier || 3, type: p.outlet_type || 'unknown' };
    groups.set(p.outlet_group, Math.max(groups.get(p.outlet_group) || 0, sourceWeight(info, p.source_kind)));
    if (!outlets.has(p.outlet)) outlets.set(p.outlet, { outlet: p.outlet, group: p.outlet_group, tier: info.tier, type: info.type, posts: 0, kinds: new Set() });
    const o = outlets.get(p.outlet);
    o.posts++;
    if (KINDS.includes(p.source_kind)) { o.kinds.add(p.source_kind); kinds.add(p.source_kind); }
    if (p.url_hash) articles.add(p.url_hash);
  }
  const base = [...groups.values()].reduce((a, b) => a + b, 0);
  const score = (base + 0.25 * Math.max(0, articles.size - groups.size)) * (1 + 0.15 * Math.max(0, kinds.size - 1));
  const list = [...outlets.values()].map((o) => ({ ...o, kinds: [...o.kinds].sort() }))
    .sort((a, b) => b.posts - a.posts || a.tier - b.tier || a.outlet.localeCompare(b.outlet));
  return { score: Math.round(score * 1000) / 1000, independent_sources: groups.size, articles: articles.size, kinds: [...kinds].sort(), outlets: list };
}

function tfidf(points) {
  const df = new Map();
  for (const p of points) {
    p._terms = new Map();
    for (const [fld, toks] of Object.entries(fieldTokens(p.claim))) {
      for (const t of toks) p._terms.set(t, Math.max(p._terms.get(t) || 0, FIELD_W[fld]));
    }
    for (const t of p._terms.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = points.length;
  for (const p of points) {
    const v = new Map();
    for (const [t, tf] of p._terms) v.set(t, tf * (Math.log((n + IDF_PRIOR + 1) / (df.get(t) + 1)) + 1));
    const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
    p._vec = new Map([...v].map(([t, x]) => [t, x / norm]));
  }
  return df;
}

function cos(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, x] of a) s += x * (b.get(t) || 0);
  return s;
}

/**
 * @param {Array} points  [{ key, claim, sentence, propTruth, confidence (0-1), posts, debunkPosts, days:number[] (ms) }]
 *   posts: [{ post, score, comments, crossposts, subreddit, outlet, outlet_group, tier, outlet_type, source_kind, url_hash, day }]
 */
export function cluster(points, cfg = DEFAULT_CONFIG, now = Date.now()) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  points = points.filter((p) => p.propTruth <= c.maxTruth);
  for (const p of points) {
    p.falsity = Math.max(0, (10 - p.propTruth) / 10);
    p.F = p.falsity * p.confidence;
    p.reach = reachOf(p.posts);
    p.div = diversity(p.posts);
    p.weight = p.F * (1 + Math.log1p(p.posts.length)) * (1 + p.reach / 4) * (1 + c.diversityBias * p.div.score);
    p.t = p.days.length ? p.days.reduce((a, b) => a + b, 0) / p.days.length : now;
    p.links = new Set([...p.posts, ...p.debunkPosts].map((x) => x.url_hash).filter(Boolean));
  }
  const df = tfidf(points);
  const n = points.length;
  const index = new Map(), linkIndex = new Map();
  points.forEach((p, i) => {
    for (const t of p._terms.keys()) if (n < 20 || df.get(t) <= 0.3 * n) (index.get(t) || index.set(t, []).get(t)).push(i);
    for (const u of p.links) (linkIndex.get(u) || linkIndex.set(u, []).get(u)).push(i);
  });
  const nbrs = points.map(() => new Map());
  points.forEach((p, i) => {
    const cand = new Set();
    for (const t of p._terms.keys()) for (const j of index.get(t) || []) cand.add(j);
    for (const u of p.links) for (const j of linkIndex.get(u) || []) cand.add(j);
    for (const j of cand) {
      if (j <= i) continue;
      const q = points[j];
      const cs = cos(p._vec, q._vec);
      const shared = p.links.size && q.links.size ? [...p.links].filter((u) => q.links.has(u)).length / Math.min(p.links.size, q.links.size) : 0;
      if (cs < 0.1 && shared === 0) continue;
      const sim = 0.7 * cs + 0.2 * shared + 0.1 * Math.exp(-Math.abs(p.t - q.t) / DAY / c.timeTau);
      if (sim >= c.simThreshold) { nbrs[i].set(j, sim); nbrs[j].set(i, sim); }
    }
  });

  // weighted DBSCAN (+ a minimum number of posts in the neighbourhood)
  const mass = points.map((p, i) => p.weight + [...nbrs[i].keys()].reduce((s, j) => s + points[j].weight, 0));
  const postsAround = points.map((p, i) => p.posts.length + [...nbrs[i].keys()].reduce((s, j) => s + points[j].posts.length, 0));
  const core = points.map((_, i) => mass[i] >= c.minMass && postsAround[i] >= c.minPosts);
  const label = new Array(n).fill(-1);
  const order = [...points.keys()].sort((a, b) => points[b].weight - points[a].weight || (points[a].key < points[b].key ? -1 : 1));
  let next = 0;
  for (const i of order) {
    if (!core[i] || label[i] !== -1) continue;
    label[i] = next;
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      for (const j of nbrs[k].keys()) if (core[j] && label[j] === -1) { label[j] = next; stack.push(j); }
    }
    next++;
  }
  for (const i of order) {
    if (label[i] !== -1 || core[i]) continue;
    let best = null;
    for (const [j, s] of nbrs[i]) if (core[j] && (!best || s > best[0])) best = [s, j];
    if (best) label[i] = label[best[1]];
  }
  const groups = new Map();
  label.forEach((l, i) => { if (l >= 0) (groups.get(l) || groups.set(l, []).get(l)).push(i); });
  const clusters = [...groups.values()].map((idx) => summarise(idx.map((i) => points[i]), idx, nbrs, now))
    .sort((a, b) => b.severity.score - a.severity.score || b.mass - a.mass);
  return { points: n, clusters };
}

function summarise(members, idx, nbrs, now) {
  const total = members.reduce((s, m) => s + m.weight, 0) || 1e-9;
  const pos = new Map(idx.map((i, k) => [i, k]));
  const centrality = (k) => members[k].weight + [...nbrs[idx[k]]].reduce((s, [j, sim]) => s + (pos.has(j) ? members[pos.get(j)].weight * sim : 0), 0);
  let rep = 0;
  for (let k = 1; k < members.length; k++) if (centrality(k) > centrality(rep)) rep = k;
  const posts = new Map();
  for (const m of members) for (const p of m.posts) posts.set(p.post, p);
  const debunks = new Set(members.flatMap((m) => m.debunkPosts.map((p) => p.post)));
  const div = diversity([...posts.values()]);
  const reach = reachOf([...posts.values()]);
  const subs = new Map();
  for (const p of posts.values()) if (p.subreddit) subs.set(p.subreddit, (subs.get(p.subreddit) || 0) + 1);
  const recent = [...posts.values()].filter((p) => p.day >= now - 7 * DAY).length;
  const prev = [...posts.values()].filter((p) => p.day >= now - 14 * DAY && p.day < now - 7 * DAY).length;
  const growth = (recent - prev) / Math.max(1, prev);
  const falsity = members.reduce((s, m) => s + m.weight * m.falsity, 0) / total;
  const q = members.reduce((s, m) => s + m.weight * m.confidence, 0) / total;
  const d = 1 - Math.exp(-div.score / 3);
  const r = 1 - Math.exp(-reach / 8);
  const s = 1 - Math.exp(-(posts.size + 2 * subs.size) / 20);
  const v = Math.min(Math.max(growth, 0), 3) / 3;
  const score = 100 * falsity * (0.5 + 0.5 * q) * (0.35 * d + 0.3 * r + 0.2 * s + 0.15 * v);
  const round = (x, k = 3) => Math.round(x * 10 ** k) / 10 ** k;
  const ordered = [...members].sort((a, b) => b.weight - a.weight);
  const sum = (f) => [...posts.values()].reduce((acc, p) => acc + Math.max(0, p[f] || 0), 0);
  return {
    id: `local_${members[rep].key.slice(3, 15)}`,
    label: members[rep].sentence,
    representative: members[rep].key,
    most_pushed: ordered[0].key,
    mass: round(total),
    members: ordered.map((m) => ({
      key: m.key, sentence: m.sentence, weight: round(m.weight), share: round(m.weight / total, 4), prop_truth: m.propTruth,
      spreading_posts: m.posts.length, debunking_posts: m.debunkPosts.length, independent_sources: m.div.independent_sources,
    })),
    metrics: {
      spreading_posts: posts.size, debunking_posts: debunks.size, subreddit_count: subs.size,
      subreddits: [...subs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([subreddit, n]) => ({ subreddit, posts: n })),
      score: sum('score'), comments: sum('comments'), crossposts: sum('crossposts'), reach: round(reach, 2),
      independent_sources: div.independent_sources, source_articles: div.articles, outlets: div.outlets.slice(0, 20),
      recent_posts: recent, previous_posts: prev, growth: round(growth, 2),
    },
    severity: {
      score: Math.round(score * 10) / 10,
      components: { falsity: round(falsity), confidence: round(q), source_diversity: round(d), reach: round(r), spread: round(s), velocity: round(v) },
      diversity_score: div.score,
    },
  };
}
