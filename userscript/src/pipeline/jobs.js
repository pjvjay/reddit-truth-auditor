/**
 * The analysis pipeline. A "job" is one post being looked at in this tab.
 *
 * Order of checks - cheapest first, every result stored in the research log:
 *   0  already in the research log (this post)                          free
 *   1  satire subreddit · crosspost / same link / near-identical post    free
 *   1b community list: link known to spread an agreed mistruth           free
 *   2  extraction call: claim, tone, canonical form, cited outlet        1 small call
 *   2a evident joke not passed off as fact                               stop
 *   2b same proposition / same claim already audited (local log)         stop
 *   2c community list: same proposition / similar claim                  stop
 *   3  web research (Tavily) + audit call                                full check
 *
 * The UI is never called directly - state changes are emitted as events.
 */
import { settings, dupThreshold } from '../core/settings.js';
import { emit, on } from '../core/events.js';
import { log } from '../core/logger.js';
import { str, squash, truncate, asBool } from '../core/util.js';
import { postTokens, similarity, urlKey } from '../text/tokenize.js';
import { toneSignals, toneClass, TONES, NON_LITERAL } from '../text/tone.js';
import { buildCanon } from '../text/canonical.js';
import { fetchPostJson, mergePost } from '../reddit/enricher.js';
import { llmJson, tavilySearch } from '../analysis/llm.js';
import { buildExtractMessages, buildAuditMessages } from '../analysis/prompts.js';
import { normaliseAudit, toneSkipResult, noClaimResult, reuseResult, communityResult } from '../analysis/results.js';
import { isFlagged } from '../analysis/risk.js';
import { researchLog } from '../store/research-log.js';
import { addUsage, addStats, recordSaving, budgetLeft } from '../store/usage.js';
import { knowledge } from '../community/knowledge.js';
import { communityConfigured } from '../community/config.js';
import { isReportable, reportContext } from '../community/publisher.js';
import { visible } from './scanner.js';

/** @type {Map<string, object>} id -> job (this tab's session) */
export const jobs = new Map();
const queue = []; //          queued jobs; most recent = highest priority
const announced = new Set(); // flagged ids that already surfaced the panel
let running = 0;

/** Fatal error (invalid key / no quota) that stops the queue until fixed. */
export const runtime = { halted: null };

const ARTICLE_KINDS = ['news', 'opinion', 'analysis', 'video', 'social', 'blog'];

const subList = (s) => String(s || '').split(/[\s,]+/).map((x) => x.replace(/^\/?r\//i, '').toLowerCase()).filter(Boolean);
function subAllowed(sub) {
  const s = String(sub || '').toLowerCase();
  const allow = subList(settings.subsAllow);
  if (allow.length && !allow.includes(s)) return false;
  return !subList(settings.subsBlock).includes(s);
}

// ---------------------------------------------------------------- job state
function newJob(id, el, post) {
  const job = { id, el, post, state: 'queued', stage: null, result: null, error: null, created: Date.now(), fromCache: false, reused: false };
  jobs.set(id, job);
  return job;
}

function update(job, patch) {
  Object.assign(job, patch || {});
  if (jobs.has(job.id)) {
    emit('job:update', job);
    emit('status:changed');
  }
}

export function removeJob(job) {
  jobs.delete(job.id);
  const qi = queue.indexOf(job);
  if (qi >= 0) queue.splice(qi, 1);
  announced.delete(job.id);
  emit('job:removed', job.id);
  emit('status:changed');
}

/** Surface newly flagged posts (once per post per session). */
function announce(job) {
  emit('job:update', job);
  if (!isFlagged(job) || announced.has(job.id)) return;
  announced.add(job.id);
  emit('job:alert', job);
}

/**
 * Store a result in the research log together with the public post metadata needed
 * to publish it later - whether or not the community server is configured or reachable.
 * origin: 'audit' | 'local' | 'community' for verdicts, null for skips.
 */
function record(id, post, r, origin, attributed = null) {
  r.origin = origin;
  r.report = reportContext(post, attributed);
  researchLog.put(id, r, post, { publishable: !!origin && isReportable(r) });
}

// ---------------------------------------------------------------- free shortcuts
function showLogged(id, el, post, r, { reused = false } = {}) {
  const job = newJob(id, el, { ...post, ...(r.post || {}) });
  job.fromCache = true;
  job.reused = reused;
  update(job, { state: r.kind === 'skip' ? 'skipped' : 'done', result: r });
  emit('job:visible', id, visible.has(el));
  announce(job);
  return job;
}

/** Tier 1: crosspost / same link / near-identical text already in the log. */
function duplicateOf(post) {
  if (!settings.dedupe) return null;
  const m = researchLog.findSimilarPost(post);
  const orig = m && researchLog.get(m.id);
  if (!orig) return null;
  log('reused', post.id, 'from', m.id, m.via, m.sim);
  return reuseResult(m.id, orig, post, m.via, m.sim);
}

/** Dedicated satire subreddit - nothing to fact-check, no tokens. */
function satireVenue(post) {
  if (!settings.ignoreSatire || !settings.skipSatireVenues) return null;
  const sig = toneSignals(post);
  return sig.frame === 'satire-venue' ? toneSkipResult(post, 'satirical', 'venue', '', sig.hints) : null;
}

/** Called by the scanner when a post has been on screen long enough. */
export function onDwell(el, adapter) {
  if (!el.isConnected) return;
  const dom = adapter.read(el);
  if (!dom.id || !dom.title || dom.promoted) return;
  let job = jobs.get(dom.id);
  if (job) {
    job.el = el;
    emit('job:visible', job.id, true);
    if (job.state === 'done') announce(job); else emit('job:update', job);
    return;
  }
  if (!subAllowed(dom.subreddit)) return;

  let logged = researchLog.get(dom.id);
  if (logged && logged.toneSkip && !settings.ignoreSatire) { researchLog.remove(dom.id); logged = null; } // satire should now be audited
  if (logged) { recordSaving('revisit'); showLogged(dom.id, el, dom, logged, { reused: !!logged.dupOf }); return; }

  const venue = satireVenue(dom);
  if (venue) {
    researchLog.put(dom.id, venue, dom);
    recordSaving('tone-venue');
    showLogged(dom.id, el, dom, venue);
    return;
  }

  const dup = duplicateOf(dom);
  if (dup) {
    record(dom.id, dom, dup, 'local');
    recordSaving('dup');
    showLogged(dom.id, el, dom, dup, { reused: true });
    return;
  }

  if (!settings.apiKey) { emit('ui:banners'); return; }
  if (settings.paused || runtime.halted) return;

  job = newJob(dom.id, el, dom);
  queue.push(job);
  update(job);
  emit('job:visible', job.id, true);
  if (settings.autoOpen === 'always') emit('ui:open', 'activity');
  pump();
}

/** A near-identical post being checked right now (e.g. two crossposts on screen together). */
function inflightTwin(job) {
  const tt = postTokens(job.post), uk = urlKey(job.post.url), thr = dupThreshold(), fr = toneSignals(job.post).frame;
  for (const other of jobs.values()) {
    if (other === job || other.state !== 'running' || !other.fp || other.fp.fr !== fr) continue;
    if (job.post.crosspostParent === other.id || other.post.crosspostParent === job.id) return other;
    const sim = similarity(tt, other.fp.tt);
    if (sim >= thr || (uk && uk === other.fp.url && sim >= Math.min(0.5, thr))) return other;
  }
  return null;
}

// ---------------------------------------------------------------- queue
export function pump() {
  if (settings.paused || runtime.halted) return;
  const max = Math.min(4, Math.max(1, parseInt(settings.maxConcurrent, 10) || 1));
  while (running < max && queue.length) {
    if (budgetLeft() <= 0) {
      queue.splice(0).forEach((j) => update(j, { state: 'blocked' }));
      emit('ui:banners');
      return;
    }
    // Prefer what the user is looking at right now, then the most recently seen.
    let idx = -1;
    for (let i = queue.length - 1; i >= 0; i--) if (visible.has(queue[i].el)) { idx = i; break; }
    if (idx < 0) idx = queue.length - 1;
    const job = queue.splice(idx, 1)[0];
    if (!jobs.has(job.id) || job.state !== 'queued') continue;
    running++;
    run(job).finally(() => { running--; emit('status:changed'); pump(); });
  }
  emit('status:changed');
}

export const queueStats = () => {
  let active = 0, queued = 0;
  for (const j of jobs.values()) { if (j.state === 'running') active++; else if (j.state === 'queued') queued++; }
  return { active, queued };
};

function finish(job, r, { state = 'done', origin = null, saving = null, reused = false } = {}) {
  record(job.id, job.post, r, origin, job.attributed);
  if (saving) recordSaving(saving);
  addUsage({ checks: 1, ...(origin === 'community' ? { community: 1 } : {}) });
  update(job, { state, stage: null, result: r, reused });
  if (state === 'done') announce(job);
}

async function run(job) {
  const meter = { usd: 0 };
  let release;
  job.done = new Promise((res) => { release = res; });
  const force = !!job.force;
  job.force = false;
  try {
    update(job, { state: 'running', stage: 'extract', error: null, reused: false, fromCache: false });
    job.post = mergePost(job.post, await fetchPostJson(job.id));
    job.post.id = job.id;
    if (!subAllowed(job.post.subreddit)) { removeJob(job); return; }
    const sig = toneSignals(job.post);

    if (!force) {
      const venue = satireVenue(job.post); // full post data may reveal a satire link in a satire sub
      if (venue) {
        researchLog.put(job.id, venue, job.post);
        recordSaving('tone-venue');
        update(job, { state: 'skipped', stage: null, result: venue });
        return;
      }
    }

    if (settings.dedupe && !force) {
      const twin = inflightTwin(job); // wait for an equivalent post mid-check instead of paying twice
      if (twin) {
        update(job, { stage: 'wait' });
        await twin.done;
        update(job, { stage: 'extract' });
      }
      const dup = duplicateOf(job.post);
      if (dup) {
        record(job.id, job.post, dup, 'local');
        recordSaving('dup');
        update(job, { state: dup.kind === 'skip' ? 'skipped' : 'done', stage: null, result: dup, reused: true });
        announce(job);
        return;
      }
    }

    // Register as in-flight BEFORE any further await, so an identical twin waits for us.
    job.fp = { tt: postTokens(job.post), url: urlKey(job.post.url), fr: sig.frame };

    if (communityConfigured() && knowledge.syncing) await knowledge.syncing.catch(() => {});
    if (!force && knowledge.usable() && (sig.frame === 'literal' || sig.frame === 'satire-link')) {
      const cm = await knowledge.matchLink(job.post);
      if (cm) { finish(job, communityResult(cm, job.post, null, null, sig), { origin: 'community', saving: 'community-link', reused: true }); return; }
    }

    // 2. Extraction
    const candidates = settings.dedupe && !force ? researchLog.claimCandidates(job.post) : [];
    const ext = await llmJson(buildExtractMessages(job.post, candidates, sig), settings, meter);
    addStats({ extractChecks: 1, extractUsd: meter.usd });
    ext.claim = str(ext.claim);
    ext.tone = TONES.includes(str(ext.tone).toLowerCase()) ? str(ext.tone).toLowerCase() : 'unclear';
    ext.presented_as_fact = NON_LITERAL.includes(ext.tone) && asBool(ext.presented_as_fact);
    const verifiable = asBool(ext.is_verifiable);
    const canon = verifiable && ext.claim ? await buildCanon(ext.canonical) : null;
    const att = ext.attributed_source && typeof ext.attributed_source === 'object' ? ext.attributed_source : null;
    job.attributed = att && str(att.outlet)
      ? { outlet: truncate(squash(str(att.outlet)), 80), kind: ARTICLE_KINDS.includes(str(att.kind)) ? str(att.kind) : 'unknown' } : null;

    if (!verifiable || !ext.claim) { finish(job, noClaimResult(job.post, ext), { state: 'skipped' }); return; }

    // 2a. Evident joke/satire not passed off as fact
    if (!force && settings.ignoreSatire && NON_LITERAL.includes(ext.tone) && !ext.presented_as_fact && str(ext.tone_confidence).toLowerCase() !== 'low') {
      const r = toneSkipResult(job.post, ext.tone, 'model', str(ext.summary), sig.hints);
      r.claim = ext.claim;
      finish(job, r, { state: 'skipped', saving: 'tone-model' });
      return;
    }

    // 2b. Same proposition / claim already audited (same tone class)
    if (settings.dedupe && !force) {
      const tc = toneClass(ext.tone, ext.presented_as_fact);
      let match = canon ? researchLog.findProposition(canon.key, job.id, tc) : null;
      const lab = /^C(\d+)$/i.exec(str(ext.same_as));
      const cand = lab && candidates[Number(lab[1]) - 1];
      if (!match && cand && cand.tc === tc) match = { id: cand.id, via: 'semantic', sim: null };
      else if (!match && cand) log('rejected same_as: tone class', cand.tc, '!=', tc);
      if (!match) match = researchLog.findSimilarClaim(ext.claim, job.id, tc);
      const orig = match && researchLog.get(match.id);
      if (orig && orig.kind === 'audit') {
        finish(job, reuseResult(match.id, orig, job.post, match.via, match.sim, canon), { origin: 'local', saving: 'claim', reused: true });
        return;
      }
    }

    // 2c. Community list
    if (!force) {
      const cm = knowledge.matchCanon(canon);
      if (cm) { finish(job, communityResult(cm, job.post, ext, canon, sig), { origin: 'community', saving: 'community', reused: true }); return; }
    }

    // 3. Web research + audit
    let research = null;
    if (settings.tavilyKey) {
      update(job, { stage: 'research', claim: ext.claim });
      try { research = await tavilySearch(ext.query || ext.claim); } catch (e) { research = { error: e.message, results: [] }; log(e); }
    } else {
      job.claim = ext.claim;
    }
    update(job, { stage: 'audit' });
    const audit = await llmJson(buildAuditMessages(job.post, ext, research, sig), settings, meter);
    const r = normaliseAudit(audit, ext, research, job.post, sig);
    r.canon = canon;
    addStats({ fullChecks: 1, fullUsd: meter.usd });
    finish(job, r, { origin: 'audit' });
  } catch (e) {
    log('job failed', job.id, e);
    update(job, { state: 'error', stage: null, error: e.message || String(e) });
    if (e.fatal) {
      runtime.halted = e.message;
      queue.splice(0).forEach((j) => update(j, { state: 'blocked' }));
      emit('ui:banners');
      emit('ui:open', 'error');
    }
  } finally {
    job.fp = null;
    release();
  }
}

// ---------------------------------------------------------------- user actions
/** Re-run a post. force=true also bypasses duplicate / community matching ("Check anyway"). */
export function recheck(job, force = true) {
  researchLog.remove(job.id);
  announced.delete(job.id);
  if (!settings.apiKey) { emit('ui:banners'); return; }
  if (!jobs.has(job.id)) jobs.set(job.id, job);
  job.force = force;
  update(job, { state: 'queued', stage: null, result: null, error: null, fromCache: false, reused: false });
  queue.push(job);
  pump();
}

/** After settings change: re-derive flags without re-running the model. */
export function reevaluateAll() {
  for (const job of jobs.values()) {
    if (isFlagged(job)) announced.add(job.id); // the user is looking at the panel - no surprise pop-ups
    emit('job:update', job);
  }
  for (const job of jobs.values()) if (job.state === 'blocked') { job.state = 'queued'; queue.push(job); emit('job:update', job); }
  if (!settings.ignoreSatire && settings.apiKey) {
    for (const job of [...jobs.values()]) if (job.state === 'skipped' && job.result && job.result.toneSkip) recheck(job, false);
  }
  emit('status:changed');
  pump();
}

/** Clear a fatal stop ("Try again"). */
export function clearHalt() { runtime.halted = null; emit('ui:banners'); reevaluateAll(); }

/** Drop every finished card from this session (the research log is kept). */
export function clearSession() {
  for (const job of [...jobs.values()]) if (job.state !== 'running') removeJob(job);
}

// keep job elements current when Reddit re-renders a post
on('post:element', (id, el) => { const job = jobs.get(id); if (job) { job.el = el; emit('job:update', job); } });
// narrative info may arrive with a feed update
on('community:feed', () => { for (const job of jobs.values()) if (job.state === 'done') emit('job:update', job); });
