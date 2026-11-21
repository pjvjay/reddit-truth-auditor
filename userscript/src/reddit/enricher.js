/**
 * Full post data from Reddit's own JSON (/by_id), batched so N visible posts
 * cost one same-origin request. Falls back to on-page text if it fails.
 */
import { log } from '../core/logger.js';
import { normId } from './adapters.js';

const pending = new Map(); // id -> [resolve]
let timer = null;

async function flush() {
  timer = null;
  const batch = [...pending.entries()].slice(0, 50);
  batch.forEach(([id]) => pending.delete(id));
  if (pending.size) timer = setTimeout(flush, 150);
  const map = {};
  try {
    const res = await fetch(`${location.origin}/by_id/${batch.map((b) => b[0]).join(',')}.json?raw_json=1`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const j = await res.json();
      for (const c of (j && j.data && j.data.children) || []) if (c && c.data && c.data.name) map[c.data.name] = c.data;
    } else log('by_id HTTP', res.status);
  } catch (e) { log('by_id failed, using on-page text only', e); }
  for (const [id, fns] of batch) fns.forEach((fn) => fn(map[id] || null));
}

/** Raw Reddit JSON for a post id, or null. */
export function fetchPostJson(id) {
  return new Promise((resolve) => {
    if (!pending.has(id)) pending.set(id, []);
    pending.get(id).push(resolve);
    if (!timer) timer = setTimeout(flush, 150);
  });
}

/** Merge on-page data with Reddit's JSON (full body, link, crosspost parent, engagement, creation time). */
export function mergePost(dom, j) {
  if (!j) return dom;
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const de = dom.engagement || {};
  return {
    ...dom,
    title: j.title || dom.title,
    body: j.selftext || dom.body,
    subreddit: j.subreddit || dom.subreddit,
    flair: j.link_flair_text || dom.flair,
    url: j.is_self ? '' : j.url || dom.url,
    domain: j.domain || dom.domain,
    permalink: j.permalink || dom.permalink,
    author: j.author || dom.author,
    crosspostParent: normId(j.crosspost_parent)
      || (Array.isArray(j.crosspost_parent_list) && j.crosspost_parent_list[0] && normId(j.crosspost_parent_list[0].name)) || null,
    engagement: {
      score: num(j.score, de.score || 0),
      comments: num(j.num_comments, de.comments || 0),
      upvote_ratio: num(j.upvote_ratio, null),
      crossposts: num(j.num_crossposts, 0),
      subscribers: num(j.subreddit_subscribers, 0),
    },
    createdUtc: num(j.created_utc, dom.createdUtc || null),
  };
}
