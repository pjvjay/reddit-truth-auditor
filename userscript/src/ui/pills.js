/** Status badges on Reddit posts ("Fact-checking…", "Likely false · 90% risk", …). */
import { settings } from '../core/settings.js';
import { emit } from '../core/events.js';
import { effectiveRisk, isFlagged, riskBand, riskLabel, toneSkipLabel } from '../analysis/risk.js';
import { harmlessJoke } from '../text/tone.js';
import { knowledge } from '../community/knowledge.js';
import { adapterFor } from '../reddit/adapters.js';
import { adapterForElement } from '../pipeline/scanner.js';
import { h } from './dom.js';

const mounted = new Map(); // id -> { pill, mount, el }

export function removePill(id) {
  const rec = mounted.get(id);
  if (rec) { rec.mount.remove(); mounted.delete(id); }
}

function label(job) {
  if (job.state === 'queued') return [h('span', { class: 'rta-dot' }), 'Queued for fact-check'];
  if (job.state === 'running') return [h('span', { class: 'rta-spin' }), 'Fact-checking…'];
  if (job.state === 'error') return [h('span', { class: 'rta-dot' }), 'Check failed'];
  const r = job.result;
  if (r.toneSkip) return [h('span', { class: 'rta-dot' }), `${toneSkipLabel(r)} · not fact-checked`];
  const flagged = isFlagged(job);
  const cl = r.canon && flagged ? knowledge.clusterOf(r.canon.key) : null;
  const text = settings.ignoreSatire && harmlessJoke(r) && !flagged
    ? riskLabel(r)
    : `${riskLabel(r)} · ${effectiveRisk(r)}% risk${cl && cl.severity >= 60 ? ' · widespread' : ''}`;
  return [h('span', { class: 'rta-dot' }), text];
}

/** Create / update / remove the badge for a job. */
export function renderPill(job) {
  const el = job.el;
  if (el && el.isConnected) {
    if (isFlagged(job)) el.setAttribute('data-rta-flagged', '1');
    else el.removeAttribute('data-rta-flagged');
  }
  const toneSkip = job.state === 'skipped' && job.result && job.result.toneSkip;
  const show = settings.inlineBadges && el && el.isConnected && (['queued', 'running', 'done', 'error'].includes(job.state) || toneSkip);
  let rec = mounted.get(job.id);
  if (rec && (!show || rec.el !== el || !rec.mount.isConnected)) { removePill(job.id); rec = null; }
  if (!show) return;
  if (!rec) {
    const pill = h('button', {
      class: 'rta-pill', type: 'button', title: 'Reddit Truth Auditor - click for details',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); emit('ui:open', 'pill'); emit('ui:focus', job.id); },
    });
    const mount = (adapterForElement(el) || adapterFor(el)).mountPill(el, pill);
    rec = { pill, mount, el };
    mounted.set(job.id, rec);
  }
  const { pill } = rec;
  pill.removeAttribute('data-band');
  pill.removeAttribute('data-flagged');
  if (job.state === 'done' || toneSkip) {
    pill.setAttribute('data-band', toneSkip ? 'satire' : riskBand(job.result));
    if (isFlagged(job)) pill.setAttribute('data-flagged', '1');
  }
  pill.replaceChildren(...label(job));
}
