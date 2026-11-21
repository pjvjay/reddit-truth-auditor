/** Result cards in the panel (Live / Flagged lists and History). */
import { settings } from '../core/settings.js';
import { emit } from '../core/events.js';
import { ago, safeUrl, hostOf, truncate, plural } from '../core/util.js';
import { toneOf, isNonLiteral, harmlessJoke, satireAsFact } from '../text/tone.js';
import { effectiveRisk, isFlagged, riskBand, riskLabel, toneSkipLabel } from '../analysis/risk.js';
import { researchLog } from '../store/research-log.js';
import { knowledge } from '../community/knowledge.js';
import { jobs, recheck, removeJob } from '../pipeline/jobs.js';
import { h, icon, setChildren } from './dom.js';
import { ui } from './context.js';

const MAX_CARDS = 80;
const STAGE_TEXT = { extract: 'Identifying the factual claim…', research: 'Searching the web for sources…', audit: 'Weighing the evidence…', wait: 'Same post is being checked – waiting to reuse it…' };
const STAGE_ICON = { extract: 'quote', research: 'search', audit: 'scale', wait: 'clock' };
const REUSE_TEXT = {
  crosspost: 'Crosspost of a post already checked',
  link: 'Links to the same article as a post already checked',
  text: 'Near-identical to a post already checked',
  claim: 'Makes the same claim as a post already checked',
  semantic: 'Makes the same claim (judged by the model) as a post already checked',
  proposition: 'Makes the same claim as a post already checked',
};

const btn = (label, onclick, { cls = 'btn small', title, iconName } = {}) =>
  h('button', { class: cls, type: 'button', title, onclick }, iconName ? icon(iconName, 13) : null, label);

function metaRow(job, extra) {
  const p = job.post || {};
  const items = [p.subreddit ? `r/${p.subreddit}` : null, ...(extra || [])].filter(Boolean);
  return h('div', { class: 'meta' }, items.flatMap((x, i) => (i ? [h('span', { class: 'sep' }, '•'), x] : [x])));
}

function forgetButton(job) {
  return btn('Forget', () => {
    researchLog.remove(job.id);
    const live = jobs.get(job.id);
    if (live && live.state !== 'running') removeJob(live);
    emit('ui:history');
  }, { iconName: 'trash', title: 'Remove from the research log (it will be re-analysed next time it is seen)' });
}

const checkAnyway = (job, title) => btn('Check anyway', () => recheck(job, true), { title });

export function jumpToPost(job) {
  const el = job.el && job.el.isConnected ? job.el : null;
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('rta-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('rta-flash');
    setTimeout(() => el.classList.remove('rta-flash'), 2000);
  } else {
    const url = safeUrl(job.post && job.post.permalink);
    if (url) window.open(url, '_blank', 'noopener');
  }
}

// ---------------------------------------------------------------- notes
function canonView(c) {
  const f = c.fields;
  const q = (f.quantities || []).map((x) => `${x.value}${x.unit ? ` ${x.unit}` : ''}`).join(', ');
  return h('div', { class: 'canon' },
    h('span', {}, f.subject), h('span', {}, f.predicate), h('span', {}, f.object),
    q ? h('span', {}, q) : null, f.time ? h('span', {}, f.time) : null, f.place ? h('span', {}, f.place) : null,
    h('span', { class: c.stance === 'denies' ? 'neg' : '' }, c.stance === 'denies' ? 'post denies this' : 'post affirms this'),
    h('code', { title: 'Proposition key – identical for every post making this claim, on any device' }, `${c.key.slice(0, 15)}…`));
}

function reuseNote(job, d) {
  const url = safeUrl(d.permalink);
  const title = truncate(d.title || 'original post', 90);
  return h('div', { class: 'reuse' }, icon('refresh', 13), h('div', {},
    `${REUSE_TEXT[d.via] || 'Matches a post already checked'}${d.sim != null && d.sim < 100 ? ` (${d.sim}% similar)` : ''}: `,
    url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, title) : title,
    d.sub ? ` · r/${d.sub}` : '', d.at ? ` · ${ago(d.at)}` : '',
    ['claim', 'semantic', 'proposition'].includes(d.via) ? '. Only the quick claim check ran – web research and audit were skipped. ' : '. No tokens were spent. ',
    job.history ? null : checkAnyway(job, 'Ignore the match and run a full check (uses API credits)')));
}

function communityNote(job, r) {
  const m = r.community;
  const debunk = r.canon && r.canon.stance === 'denies';
  return h('div', { class: 'reuse community' }, icon('globe', 13), h('div', {},
    debunk ? 'This post debunks a known mistruth' : 'Known mistruth',
    ` – judged false by ${m.nClients} independent users`,
    m.via === 'fuzzy' ? ` (${m.sim}% match)` : m.via === 'link' ? ' (this link has been reported spreading it)' : '',
    `. Seen in ${plural(m.posts, 'post')} (${m.spreading} spreading, ${m.debunking} debunking). `,
    m.via === 'link' ? 'No tokens were spent. ' : 'Web research and audit were skipped. ',
    job.history ? null : checkAnyway(job, 'Ignore the community verdict and run a full check (uses API credits)')));
}

export function narrativeNote(cl) {
  const hi = cl.severity >= 60;
  return h('div', { class: `reuse narrative ${hi ? 'hi' : ''}` }, icon('trend', 13), h('div', {},
    h('b', {}, hi ? 'Widespread false narrative' : 'Part of a false narrative'),
    `: “${truncate(cl.label, 140)}” – severity ${Math.round(cl.severity)}/100 · ${plural(cl.independent_sources, 'independent source')}`,
    cl.outlets.length ? ` (${cl.outlets.join(', ')})` : '',
    ` · ${plural(cl.spreading_posts, 'post')} in ${plural(cl.subreddit_count, 'subreddit')}`,
    cl.growth > 0 ? ` · +${Math.round(cl.growth * 100)}% this week` : '', '.'));
}

// ---------------------------------------------------------------- card bodies
function queuedCard(job, title) {
  const what = job.state === 'blocked' ? 'Waiting – checks stopped/capped' : settings.paused ? 'Paused' : 'Queued';
  return [h('div', { class: 'spin queued' }, icon('clock', 15)), h('div', { class: 'main' }, title, metaRow(job, [what]), h('div', { class: 'shimmer' }))];
}

function runningCard(job, title) {
  const order = ['extract', 'research', 'audit'];
  const cur = order.indexOf(job.stage);
  const labels = { extract: 'Claim', research: settings.tavilyKey ? 'Research' : 'No search', audit: 'Verdict' };
  return [h('div', { class: 'spin' }, icon(STAGE_ICON[job.stage] || 'search', 15)),
    h('div', { class: 'main' }, title, metaRow(job), h('div', { class: 'stage' }, STAGE_TEXT[job.stage] || 'Working…'),
      job.claim ? h('div', { class: 'claim-live' }, `“${truncate(job.claim, 160)}”`) : null,
      h('div', { class: 'steps' }, order.map((s, i) => {
        const cls = s === 'research' && !settings.tavilyKey ? 'off' : i < cur ? 'done' : i === cur ? 'active' : '';
        return h('div', { class: `step ${cls}` }, h('div', { class: 'bar' }), h('div', { class: 'lbl' }, labels[s]));
      })))];
}

function toneSkipCard(job, title) {
  const r = job.result;
  const why = r.reason === 'venue' ? (r.toneHints && r.toneHints[0]) || 'Posted in a satire subreddit.' : 'Evident satire/joke that is not presented as real news.';
  return [h('div', { class: 'skip-ico sat' }, icon('smile', 14)),
    h('div', { class: 'main' }, title,
      metaRow(job, [h('span', { class: 'tag sat' }, toneSkipLabel(r)), 'not fact-checked', job.history ? ago(job.loggedAt) : null]),
      h('div', { class: 'note' }, `${why} ${r.reason === 'venue' ? 'No tokens were spent.' : 'Web research and audit were skipped.'}`),
      h('div', { class: 'actions' }, job.history ? forgetButton(job) : checkAnyway(job, 'Fact-check the literal claim anyway (uses API credits)')))];
}

function noClaimCard(job, title) {
  const r = job.result || {};
  const why = ['humorous', 'satirical', 'sarcastic'].includes(r.tone) ? ` (${r.tone === 'humorous' ? 'joke' : r.tone})` : r.contentType ? ` (${r.contentType})` : '';
  return [h('div', { class: 'skip-ico' }, icon('quote', 14)),
    h('div', { class: 'main' }, title, metaRow(job, [`No checkable claim${why}`, job.history ? ago(job.loggedAt) : null]),
      job.history ? h('div', { class: 'actions' }, forgetButton(job)) : null)];
}

function errorCard(job, title) {
  return [h('div', { class: 'err-ico' }, icon('alert', 14)),
    h('div', { class: 'main' }, title, metaRow(job, ['Check failed']), h('div', { class: 'note' }, job.error || 'Unknown error'),
      h('div', { class: 'actions' }, btn('Retry', () => recheck(job), { iconName: 'refresh' })))];
}

function verdictCard(job, title) {
  const r = job.result;
  const p = job.post || {};
  const eff = effectiveRisk(r);
  const tone = toneOf(r);
  const flagged = isFlagged(job);
  const cluster = r.canon && (r.canon.stance === 'affirms' || eff >= 50) ? knowledge.clusterOf(r.canon.key) : null;
  const gauge = h('div', {
    class: `gauge ${riskBand(r)}`,
    title: `Risk ${eff}% (truth score ${r.truth}/10${eff !== r.risk ? `, literal risk ${r.risk}% discounted as evident ${tone}` : ''})`,
  }, h('b', {}, String(eff), h('small', {}, '%')));
  requestAnimationFrame(() => requestAnimationFrame(() => gauge.style.setProperty('--rta-p', String(eff))));

  const sources = (r.sources || []).map((s) => {
    const u = safeUrl(s.url);
    return u ? h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, s.title || u), ' ', h('span', { class: 'src-host' }, hostOf(u))) : null;
  }).filter(Boolean);
  const sec = (label, body) => (body ? h('div', { class: 'd-sec' }, h('h4', {}, label), typeof body === 'string' ? h('p', {}, body) : body) : null);
  const provenance = r.dupOf ? ' · reused from an earlier check' : r.community ? ' · community verdict' : job.fromCache ? ' · from research log' : '';
  const details = h('details', {}, h('summary', {}, 'Why this score'),
    h('div', { class: 'd-body' },
      h('div', { class: 'scores' },
        h('span', { class: 'chip' }, `Truth ${r.truth}/10`),
        h('span', { class: 'chip' }, `Tone: ${tone}${isNonLiteral(r) ? (r.presentedAsFact ? ', passed off as fact' : ', not meant as fact') : ''}`),
        h('span', { class: 'chip' }, `Satire score ${r.sarcasm}/10`),
        eff !== r.risk ? h('span', { class: 'chip' }, `Literal risk ${r.risk}% → ${eff}%`) : null,
        h('span', { class: 'chip' }, `Confidence: ${r.confidence}`),
        h('span', { class: 'chip' }, r.researched ? plural(r.sources.length, 'web source') : 'Model knowledge only')),
      sec(tone === 'sarcastic' ? 'Intended meaning checked (sarcasm decoded)' : 'Claim checked', r.claim),
      r.literalClaim ? sec('Literal (ironic) wording', r.literalClaim) : null,
      r.canon && r.canon.fields ? sec('Canonical claim', canonView(r.canon)) : null,
      (r.toneReason || (r.toneHints && r.toneHints.length)) ? sec('Tone', [r.toneReason, ...(r.toneHints || []).map((x) => `• ${x}`)].filter(Boolean).join('\n')) : null,
      sec('Fact check', r.factualCheck),
      sec('Context', r.contextCheck),
      sources.length ? sec('Sources', h('ol', {}, sources)) : null,
      r.researchError ? sec('Web research', `Failed: ${r.researchError}`) : null,
      sec('Checked', `${new Date(r.at).toLocaleString()} · ${r.model || ''}${provenance}`)));

  const permalink = safeUrl(p.permalink);
  const canJump = !job.history || (job.el && job.el.isConnected);
  return [gauge,
    h('div', { class: 'main' },
      title,
      metaRow(job, [
        flagged ? h('span', { class: 'tag flag' }, icon('alert', 11), 'Flagged') : riskLabel(r).replace(/^Sarcasm – (.)/, (_, c) => c.toUpperCase()),
        tone === 'sarcastic' ? h('span', { class: 'tag sat' }, 'Sarcasm') : null,
        harmlessJoke(r) && flagged ? h('span', { class: 'tag sat' }, tone === 'humorous' ? 'Joke' : 'Satire') : null,
        satireAsFact(r) ? h('span', { class: 'tag flag' }, 'Satire as fact') : null,
        r.dupOf ? h('span', { class: 'tag dup' }, 'Reused') : null,
        r.community ? h('span', { class: 'tag comm' }, 'Community') : null,
        cluster && cluster.severity >= 60 && eff >= 50 ? h('span', { class: 'tag wide' }, 'Widespread') : null,
        `${r.confidence} confidence`,
        job.history ? ago(job.loggedAt) : null,
      ]),
      r.verdict ? h('div', { class: 'verdict' }, r.verdict) : null,
      r.dupOf ? reuseNote(job, r.dupOf) : null,
      r.community ? communityNote(job, r) : null,
      cluster ? narrativeNote(cluster) : null,
      !r.researched && !r.community
        ? h('div', { class: 'note' }, icon('search', 12), r.researchError ? 'Web research failed – model knowledge only' : 'Not web-verified – model knowledge only')
        : null,
      details,
      h('div', { class: 'actions' },
        canJump ? btn('Show post', () => jumpToPost(job), { iconName: 'target' }) : null,
        permalink ? h('a', { class: 'btn small', href: permalink, target: '_blank', rel: 'noopener' }, icon('external', 13), 'Open') : null,
        job.history ? forgetButton(job) : btn('Re-check', () => recheck(job), { iconName: 'refresh', title: 'Run the full check again (uses API credits)' })))];
}

/** Card body for a job (or a pseudo-job from the History tab: { history: true, loggedAt }). */
export function cardContent(job) {
  const p = job.post || {};
  const title = h('div', { class: 't', title: p.title || '' }, p.title || '(untitled post)');
  switch (job.state) {
    case 'queued': case 'blocked': return queuedCard(job, title);
    case 'running': return runningCard(job, title);
    case 'error': return errorCard(job, title);
    case 'skipped': return job.result && job.result.toneSkip ? toneSkipCard(job, title) : noClaimCard(job, title);
    default: return verdictCard(job, title);
  }
}

export const cardClass = (job, keep = []) =>
  ['card', job.state, isFlagged(job) ? 'flagged' : '', job.result && job.result.toneSkip ? 'tone' : '', ...keep].filter(Boolean).join(' ');

// ---------------------------------------------------------------- live list
export function renderCard(job) {
  if (!ui.list) return;
  let card = ui.cards.get(job.id);
  if (!card) {
    card = h('div', { class: 'card', 'data-id': job.id });
    ui.cards.set(job.id, card);
    ui.list.prepend(card);
    while (ui.list.children.length > MAX_CARDS) {
      const last = [...ui.list.children].reverse().find((c) => { const j = jobs.get(c.dataset.id); return !j || (j.state !== 'running' && !isFlagged(j)); });
      if (!last) break;
      const old = jobs.get(last.dataset.id);
      if (old) removeJob(old); else removeCard(last.dataset.id);
    }
  }
  const keep = ['onscreen', 'pulse', 'focus'].filter((c) => card.classList.contains(c));
  card.className = cardClass(job, keep);
  setChildren(card, cardContent(job), h('span', { class: 'onscreen-tag', title: 'This post is on your screen right now' }, icon('eye', 11), 'On screen'));
}

export function removeCard(id) {
  const c = ui.cards.get(id);
  if (c) c.remove();
  ui.cards.delete(id);
}

export function markOnScreen(id, on) {
  const c = ui.cards.get(id);
  if (c) c.classList.toggle('onscreen', on);
}

function scrollToCard(c, center) {
  const sc = ui.listScroll;
  const top = sc.scrollTop + (c.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  sc.scrollTo({ top: Math.max(0, center ? top - (sc.clientHeight - c.offsetHeight) / 2 : top - 12), behavior: 'smooth' });
}

/** Move a newly flagged card to the top and pulse it. */
export function pulseCard(id) {
  const c = ui.cards.get(id);
  if (!c) return;
  if (ui.list.firstElementChild !== c) ui.list.prepend(c);
  c.classList.remove('pulse');
  void c.offsetWidth;
  c.classList.add('pulse');
  clearTimeout(c._pulseT);
  c._pulseT = setTimeout(() => c.classList.remove('pulse'), 2800);
  setTimeout(() => ui.listScroll.scrollTo({ top: 0, behavior: 'smooth' }), 120);
}

export function focusCard(id) {
  const c = ui.cards.get(id);
  if (!c) return;
  if (ui.tab === 'flagged' && !c.classList.contains('flagged')) emit('ui:tab', 'live');
  setTimeout(() => scrollToCard(c, true), 60);
  c.classList.add('focus');
  setTimeout(() => c.classList.remove('focus'), 1600);
}
