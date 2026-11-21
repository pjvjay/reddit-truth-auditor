/** History tab: browse / search the local research log and the savings it produced. */
import { settings } from '../core/settings.js';
import { debounce, compact } from '../core/util.js';
import { SATIRE_DISCOUNT } from '../text/tone.js';
import { researchLog } from '../store/research-log.js';
import { getStats } from '../store/usage.js';
import { communityStatus } from '../community/config.js';
import { jobs } from '../pipeline/jobs.js';
import { h, icon, setChildren } from './dom.js';
import { cardContent, cardClass } from './cards.js';
import { ui } from './context.js';

const PAGE = 40;
let view = null; // { search, filter, stats, list, more, limit }

const FILTERS = {
  all: () => true,
  flagged: (m) => m.kind === 'a' && (settings.ignoreSatire && m.tc === 'n' ? Math.round(m.risk * SATIRE_DISCOUNT) : m.risk) >= Number(settings.riskThreshold),
  dup: (m) => !!m.dup,
  tone: (m) => m.tc === 'n' || m.tc === 'f' || !!m.ts,
  community: (m) => !!m.cm,
  skip: (m) => m.kind === 's',
};

function build() {
  const search = h('input', { class: 'inp', type: 'search', placeholder: 'Search title or subreddit…', 'aria-label': 'Search history' });
  const filter = h('select', { class: 'inp', 'aria-label': 'Filter history' },
    h('option', { value: 'all' }, 'All'),
    h('option', { value: 'flagged' }, 'Risky'),
    h('option', { value: 'dup' }, 'Reused'),
    h('option', { value: 'tone' }, 'Satire / jokes'),
    h('option', { value: 'community' }, 'Community matches'),
    h('option', { value: 'skip' }, 'No claim'));
  if (view) { search.value = view.search.value; filter.value = view.filter.value; }
  search.addEventListener('input', debounce(() => { view.limit = PAGE; renderList(); }, 200));
  filter.addEventListener('change', () => { view.limit = PAGE; renderList(); });
  view = { search, filter, stats: h('div', { class: 'h-stats' }), list: h('div', { class: 'h-list' }), more: h('div', { class: 'h-more' }), limit: PAGE };
  setChildren(ui.history, view.stats, h('div', { class: 'h-tools' }, search, filter), view.list, view.more,
    h('div', { class: 'h-note' }, `Kept for ${settings.logDays} days in your userscript manager's local storage – works offline. `
      + 'Posts in the log are never re-analysed; reposts and same-claim posts reuse the earlier verdict.'));
}

function renderStats() {
  const st = getStats();
  const stat = (v, l) => h('div', {}, h('b', {}, v), h('span', {}, l));
  setChildren(view.stats,
    stat(researchLog.size().toLocaleString(), 'posts logged'),
    stat((st.dupHits + st.claimHits + st.revisits).toLocaleString(), 'repeats skipped'),
    stat((st.toneSkips || 0).toLocaleString(), 'satire / jokes skipped'),
    stat((st.communityHits || 0).toLocaleString(), 'community matches'),
    stat(compact(communityStatus().sent || 0), 'reports shared'),
    stat(`$${st.savedUsd.toFixed(st.savedUsd < 1 ? 3 : 2)}`, 'est. saved'));
}

function renderList() {
  const q = view.search.value.trim().toLowerCase();
  const f = view.filter.value;
  const rows = researchLog.entries().filter(([, m]) => (!q || `${m.title} r/${m.sub}`.toLowerCase().includes(q)) && FILTERS[f](m));
  const cards = [];
  for (const [id, m] of rows.slice(0, view.limit)) {
    const r = researchLog.get(id);
    if (!r) continue;
    const live = jobs.get(id);
    const pseudo = { id, el: live && live.el, post: r.post || {}, state: r.kind === 'skip' ? 'skipped' : 'done', result: r, fromCache: true, reused: !!r.dupOf, history: true, loggedAt: m.t };
    cards.push(h('div', { class: cardClass(pseudo), 'data-hid': id }, ...cardContent(pseudo)));
  }
  if (!rows.length) {
    setChildren(view.list, h('div', { class: 'empty show' }, h('div', { class: 'e-icon' }, icon('clock', 24)),
      h('div', {}, q || f !== 'all' ? 'No matching posts in the log.' : 'Nothing researched yet.')));
  } else setChildren(view.list, cards);
  setChildren(view.more, rows.length > view.limit
    ? h('button', { class: 'btn small', type: 'button', onclick: () => { view.limit += PAGE; renderList(); } }, `Show more (${rows.length - view.limit} left)`)
    : null);
}

/** (Re)render the History tab. `reset` rebuilds the toolbar and resets paging. */
export function renderHistory(reset = false) {
  if (reset || !view) build();
  renderStats();
  renderList();
}
