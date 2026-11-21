/**
 * Trends tab: false narratives that are spreading.
 *   Community  - clusters from the community server (cached copy when offline)
 *   My history - the same clustering run locally over your own research log (always works offline)
 */
import { ago, clampNum, compact, plural, str } from '../core/util.js';
import { knowledge } from '../community/knowledge.js';
import { communityConfigured, communityStatus } from '../community/config.js';
import { queuedCount } from '../community/publisher.js';
import { localNarratives } from '../insights/local-narratives.js';
import { h, icon, setChildren } from './dom.js';
import { ui } from './context.js';

let source = null; // 'community' | 'local' (null = pick automatically)

function trendCard(c) {
  const sev = clampNum(c.severity && c.severity.score, 0, 100, 0);
  const m = c.metrics || {};
  const comps = (c.severity && c.severity.components) || {};
  return h('div', { class: 'tcard', 'data-cid': str(c.id) },
    h('div', { class: `tsev ${sev >= 60 ? 'hi' : sev >= 35 ? 'mid' : ''}`, title: 'Severity 0–100' }, h('div', {}, String(Math.round(sev)), h('small', {}, 'SEV'))),
    h('div', { class: 'main' },
      h('div', { class: 't' }, str(c.label)),
      h('div', { class: 'meta' }, `${plural(m.spreading_posts || 0, 'post')} · ${plural(m.subreddit_count || 0, 'subreddit')} · ${compact(m.score || 0)} upvotes · ${compact(m.comments || 0)} comments`),
      h('div', { class: 'meta' }, `${plural(m.independent_sources || 0, 'independent source')} · ${plural(m.debunking_posts || 0, 'debunking post')}`,
        m.growth > 0 ? ` · +${Math.round(m.growth * 100)}% this week` : ''),
      h('div', {}, (m.outlets || []).slice(0, 8).map((o) => h('span', { class: `oc ${o.tier === 1 ? 't1' : ''}`, title: `${str(o.group)} · tier ${o.tier} · ${plural(o.posts, 'post')}` },
        str(o.outlet), (o.kinds || []).includes('opinion') ? ' · opinion' : ''))),
      (c.members || []).slice(0, 4).map((mm) => h('div', { class: 'mem' },
        h('span', { class: 'mbar', style: { width: `${Math.max(2, Math.round((mm.share || 0) * 100))}%` } }),
        h('span', { class: 'txt' }, mm.sentence ? str(mm.sentence) : 'rarely reported variant'),
        h('small', {}, ` ${Math.round((mm.share || 0) * 100)}% of weight`))),
      h('details', {}, h('summary', {}, 'Severity breakdown'),
        h('div', { class: 'd-body' }, h('div', { class: 'scores' },
          Object.entries(comps).map(([k, v]) => h('span', { class: 'chip' }, `${k.replace(/_/g, ' ')} ${Math.round(v * 100)}%`)))))));
}

function toggle(active) {
  const b = (key, label) => h('button', { class: `seg ${active === key ? 'on' : ''}`, type: 'button', 'data-src': key, onclick: () => { source = key; renderTrends(false); } }, label);
  return h('div', { class: 'segs' }, b('community', 'Community'), b('local', 'My history'));
}

/** Render the Trends tab. */
export async function renderTrends(force = false) {
  const el = ui.trends;
  const src = source || (communityConfigured() ? 'community' : 'local');
  const head = (text, refresh) => h('div', { class: 't-head' }, h('span', {}, text),
    refresh ? h('button', { class: 'btn-icon', type: 'button', title: 'Refresh', 'aria-label': 'Refresh trends', onclick: () => renderTrends(true) }, icon('refresh', 15)) : null);
  const empty = (text) => h('div', { class: 'empty show' }, h('div', { class: 'e-icon' }, icon('trend', 24)), h('div', {}, text));

  if (src === 'local') {
    const res = localNarratives();
    setChildren(el, toggle(src),
      head('False narratives in your own history – clustered on this device, no server needed. Severity weighs independent outlets, popularity, spread and growth.', false),
      res.clusters.length ? res.clusters.map(trendCard) : empty('No narratives yet – a narrative needs the same (or a closely related) false claim in at least two posts.'));
    return;
  }

  setChildren(el, toggle(src), h('div', { class: 't-head' }, h('div', { class: 'spin', style: { width: '22px', height: '22px' } }), h('span', {}, 'Loading propagating narratives…')));
  const res = await knowledge.trends(force);
  const st = communityStatus();
  const notice = res.stale
    ? h('div', { class: 'banner warn' }, icon('alert', 16), h('div', { class: 'b-body' },
      communityConfigured()
        ? `Community server unreachable${res.at ? ` – showing narratives from ${ago(res.at)}` : ''}. `
        : 'Not connected to a community server – join in Settings to see community-wide narratives. ',
      queuedCount() ? `${plural(queuedCount(), 'report')} saved locally will be published automatically when it is reachable.` : '',
      st.syncError && communityConfigured() ? h('div', { class: 'hint' }, st.syncError) : null))
    : null;
  setChildren(el, toggle(src),
    head('False narratives spreading now – clustered across posts, ranked by severity (independent outlets, popularity, spread, growth).', true),
    notice,
    res.items.length ? res.items.map(trendCard) : empty(res.stale ? 'No cached narratives yet.' : 'No propagating narratives yet.'));
}
