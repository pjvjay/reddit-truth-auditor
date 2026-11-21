/** Builds clustering points from the local research log ("My history" narratives - works offline). */
import { researchLog } from '../store/research-log.js';
import { harmlessJoke } from '../text/tone.js';
import { propositionTruth } from '../analysis/risk.js';
import { lookupDomain, lookupName } from './outlets.js';
import { cluster } from './clustering.js';

const CONF = { high: 1, medium: 0.7, low: 0.4 };

export function localNarratives(cfg) {
  const props = new Map();
  for (const [id, m] of researchLog.entries()) {
    if (m.kind !== 'a' || !m.pk) continue;
    const r = researchLog.get(id);
    if (!r || !r.canon || harmlessJoke(r)) continue;
    const ctx = r.report || {};
    const info = ctx.source ? lookupDomain(ctx.source.domain) : ctx.attributed ? lookupName(ctx.attributed.outlet) : null;
    const post = {
      post: id, subreddit: ctx.subreddit || (r.post && r.post.subreddit) || '',
      score: (ctx.engagement || {}).score || 0, comments: (ctx.engagement || {}).comments || 0, crossposts: (ctx.engagement || {}).crossposts || 0,
      outlet: info && info.outlet, outlet_group: info && info.group, tier: info && info.tier, outlet_type: info && info.type,
      source_kind: ctx.source ? ctx.source.kind : ctx.attributed ? ctx.attributed.kind : null,
      url_hash: ctx.urlKey || null,
      day: ctx.post_day ? Date.parse(ctx.post_day) : m.t,
    };
    if (!props.has(m.pk)) props.set(m.pk, { key: m.pk, claim: r.canon.fields, sentence: r.canon.sentence, truths: [], confs: [], posts: [], debunkPosts: [], days: [] });
    const p = props.get(m.pk);
    p.truths.push(propositionTruth(r));
    p.confs.push(CONF[r.confidence] || 0.7);
    (r.canon.stance === 'denies' ? p.debunkPosts : p.posts).push(post);
    p.days.push(post.day);
  }
  const points = [...props.values()].map((p) => ({
    ...p,
    propTruth: p.truths.reduce((a, b) => a + b, 0) / p.truths.length,
    confidence: p.confs.reduce((a, b) => a + b, 0) / p.confs.length,
  }));
  return cluster(points, cfg);
}
