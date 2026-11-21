/**
 * Offline-first publishing of anonymous mistruth reports.
 *
 * The research log is the queue: results that are worth reporting are stored
 * as PENDING whether or not the community is configured or reachable. This
 * module builds reports from the stored records (using the post metadata
 * captured when the post was seen) and publishes them whenever it can:
 * on start-up, every minute, when the browser comes back online, when new
 * results arrive, after settings change, or on demand.
 *
 * Failure handling
 *   network / 5xx / 429 -> keep pending, exponential back-off (30 s … 1 h)
 *   401 / 403           -> keep pending, pause until settings change (auth error)
 *   422 / other 4xx     -> retry one report at a time to isolate the bad record,
 *                          which is then marked REJECTED (never retried)
 *   over the daily quota -> keep pending, pause until the server's quota resets
 *                          (the server says so per report, inside a 2xx response)
 * A best-effort cross-tab lock stops two tabs sending the same batch.
 */
import { storage } from '../core/env.js';
import { settings, KEYS } from '../core/settings.js';
import { emit, on } from '../core/events.js';
import { log } from '../core/logger.js';
import { utcDay, truncate, str, safeUrl, plural } from '../core/util.js';
import { urlKey } from '../text/tokenize.js';
import { hashRef } from '../text/canonical.js';
import { harmlessJoke, toneOf } from '../text/tone.js';
import { propositionTruth } from '../analysis/risk.js';
import { sourceOf } from '../reddit/source.js';
import { researchLog, PUBLISH } from '../store/research-log.js';
import { api } from './api.js';
import { knowledge } from './knowledge.js';
import { communityConfigured, clientId, communityStatus, setCommunityStatus } from './config.js';

export const BATCH_SIZE = 50;
const MAX_ROUNDS = 20;
const LOCK_KEY = 'rta.community.publishLock';
const LOCK_MS = 60e3;
const QUOTA_SLACK_MS = 60e3; //          wait this long past the reset, so clocks need not agree exactly
const QUOTA_MAX_HOLD_MS = 25 * 3600e3; // a daily quota resets within a day, whatever a server claims
const TAB = Math.random().toString(36).slice(2);
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;

let busy = false;
let fails = 0;
let nextTry = 0;
let timer = null;
let started = false;

/** Worth reporting: a canonical claim judged false - or any claim already on the community list (a vote). Never jokes. */
export function isReportable(r) {
  if (!r || r.kind !== 'audit' || !r.canon || !r.canon.fields || harmlessJoke(r)) return false;
  return propositionTruth(r) <= 4 || knowledge.has(r.canon.key);
}

/** Public post metadata captured when the post is analysed, so the report can be built later. */
export function reportContext(post, attributed = null) {
  const src = sourceOf(post);
  const e = post.engagement;
  return {
    subreddit: post.subreddit || '',
    urlKey: urlKey(post.url),
    source: src,
    attributed: !src && attributed ? attributed : null,
    engagement: e ? {
      score: Math.max(-1e6, Math.min(1e8, Math.round(e.score || 0))),
      comments: Math.max(0, Math.round(e.comments || 0)),
      upvote_ratio: Number.isFinite(e.upvote_ratio) ? Math.max(0, Math.min(1, e.upvote_ratio)) : null,
      crossposts: Math.max(0, Math.round(e.crossposts || 0)),
      subscribers: Math.max(0, Math.round(e.subscribers || 0)),
    } : null,
    post_day: post.createdUtc ? utcDay(post.createdUtc * 1000) : null,
    seen_day: utcDay(),
  };
}

/** The exact report that will be sent for a stored record (documented fields only - see docs/privacy.md). */
export async function buildReport(id, r) {
  const ctx = r.report || {};
  const sub = ctx.subreddit || (r.post && r.post.subreddit) || '';
  const link = ctx.urlKey != null ? ctx.urlKey : urlKey(r.post && r.post.url);
  return {
    claim: r.canon.fields,
    key: r.canon.key,
    claim_truth: r.truth,
    confidence: r.confidence,
    tone: toneOf(r),
    presented_as_fact: !!r.presentedAsFact,
    researched: !!r.researched,
    sources: (r.sources || []).map((x) => x.url).filter((u) => safeUrl(u)).slice(0, 3),
    verdict: truncate(str(r.verdict), 400),
    model: truncate(str(r.model), 60),
    post: await hashRef(id),
    subreddit: settings.shareSubreddit && SUBREDDIT_RE.test(sub) ? sub : null,
    url_hash: link ? await hashRef(link) : null,
    day: ctx.seen_day || utcDay(r.at),
    origin: r.origin || (r.community ? 'community' : r.dupOf ? 'local' : 'audit'),
    source: ctx.source || null,
    attributed: ctx.attributed || null,
    engagement: ctx.engagement || null,
    post_day: ctx.post_day || null,
  };
}

// ---------------------------------------------------------------- queue
const legacyOutbox = () => { const b = storage.get(KEYS.legacyOutbox, null); return Array.isArray(b) ? b : []; };

/** Pending entries this policy allows to be sent (backlog = analysed before joining). */
function eligible(limit = Infinity) {
  const since = settings.shareBacklog ? 0 : Number(settings.communityJoinedAt) || 0;
  return researchLog.pending().filter(([, m]) => m.t >= since).slice(0, limit);
}

/** Reports waiting to be published. */
export const queuedCount = () => eligible().length + legacyOutbox().length;

/** Drop everything queued (the analyses stay in the research log). */
export function discardQueued() {
  researchLog.discardPending();
  storage.remove(KEYS.legacyOutbox);
  emit('community:changed');
}

// ---------------------------------------------------------------- cross-tab lock
function acquireLock() {
  const l = storage.get(LOCK_KEY, null);
  if (l && l.owner !== TAB && l.until > Date.now()) return false;
  storage.set(LOCK_KEY, { owner: TAB, until: Date.now() + LOCK_MS });
  const c = storage.get(LOCK_KEY, null);
  return !!c && c.owner === TAB;
}
function releaseLock() {
  const l = storage.get(LOCK_KEY, null);
  if (l && l.owner === TAB) storage.remove(LOCK_KEY);
}

// ---------------------------------------------------------------- sending
function backoff(e) {
  fails++;
  nextTry = Date.now() + Math.min(3600e3, 30e3 * 2 ** Math.min(fails - 1, 7));
  setCommunityStatus({ sendError: `${e.message} – queued reports will be sent automatically when the server is reachable` });
}

// ---------------------------------------------------------------- daily quota
/**
 * The server answers reports over the sender's daily quota inside a 2xx response,
 * as rejections with code "quota" (older servers only say so in `reason`).
 * Nothing is wrong with those reports, so they stay queued until the quota resets.
 */
const overQuota = (x) => !!x && (x.code === 'quota' || (x.code == null && /quota/i.test(String(x.reason || ''))));

/** When to try again: the reset time the server gave, else the next UTC midnight (its quota runs per UTC day). */
function quotaResetAt(res) {
  const now = Date.now();
  const told = Number(res && res.quota && res.quota.resets_at) * 1000;
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.min(told > now ? told : midnight.getTime(), now + QUOTA_MAX_HOLD_MS) + QUOTA_SLACK_MS;
}

/** Time (ms) until which the server's daily quota holds the queue, or 0 when it does not. */
export function quotaHeldUntil() {
  const t = Number(communityStatus().quotaUntil) || 0;
  return t > Date.now() ? t : 0;
}

/** Status line for the UI while queued reports wait for the daily quota to reset (null otherwise). */
export function quotaNotice() {
  const until = quotaHeldUntil();
  const n = queuedCount();
  if (!until || !n) return null;
  const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Daily sharing limit reached – ${plural(n, 'report')} kept and will be sent automatically after ${at}.`;
}

/** v1.3-1.4 kept pre-built reports in an outbox; send those first. Returns false if the daily quota stopped it. */
async function drainLegacyOutbox() {
  for (let box = legacyOutbox(); box.length; box = legacyOutbox()) {
    const batch = box.slice(0, BATCH_SIZE);
    try {
      const res = await api.publish({ schema: 'rta.report/1', client: clientId(), reports: batch.map(({ _id, ...rest }) => rest) });
      const patch = { sent: communityStatus().sent + (Number(res.accepted) || 0), lastSend: Date.now(), sendError: null };
      const over = new Set((res.rejected || []).filter(overQuota).map((x) => x.index));
      if (over.size) {
        storage.set(KEYS.legacyOutbox, [...batch.filter((_, i) => over.has(i)), ...box.slice(batch.length)]);
        setCommunityStatus({ ...patch, quotaUntil: quotaResetAt(res) });
        return false;
      }
      setCommunityStatus(patch);
    } catch (e) {
      if (e.transient || e.auth) throw e;
    }
    storage.set(KEYS.legacyOutbox, box.slice(batch.length));
  }
  storage.remove(KEYS.legacyOutbox);
  return true;
}

/**
 * Publish what is queued. Safe to call any time; returns one of
 * 'disabled' | 'auth' | 'busy' | 'backoff' | 'quota' | 'locked' | 'idle' | 'sent' | 'offline'.
 * 'quota': the server's daily quota is used up - what it accepted is marked sent,
 * the rest stays queued and is sent after the quota resets (`force` tries at once).
 */
export async function flush({ force = false } = {}) {
  if (!communityConfigured() || !settings.shareReports) return 'disabled';
  if (communityStatus().authError && !force) return 'auth';
  if (busy) return 'busy';
  if (!force && Date.now() < nextTry) return 'backoff';
  if (!queuedCount()) return 'idle';
  if (!force && quotaHeldUntil()) return 'quota';
  if (!acquireLock()) return 'locked';
  busy = true;
  let result = 'idle';
  try {
    const drained = await drainLegacyOutbox();
    if (!drained) result = 'quota';
    let size = BATCH_SIZE;
    for (let round = 0; drained && round < MAX_ROUNDS; round++) {
      const batch = eligible(size);
      if (!batch.length) break;
      const built = [], gone = [];
      for (const [id] of batch) {
        const r = researchLog.get(id);
        if (r && isReportable(r)) built.push([id, await buildReport(id, r)]);
        else gone.push(id);
      }
      if (gone.length) researchLog.setPublishState(gone, PUBLISH.NONE);
      if (!built.length) continue;
      const body = { schema: 'rta.report/1', client: clientId(), reports: built.map(([, rep]) => rep) };
      storage.set(KEYS.lastPayload, body);
      try {
        const res = await api.publish(body);
        const rejected = new Map((res.rejected || []).map((x) => [x.index, x]));
        const sent = [], refused = [], waiting = [];
        built.forEach(([id], i) => {
          const why = rejected.get(i);
          (!why ? sent : overQuota(why) ? waiting : refused).push(id);
        });
        researchLog.setPublishState(sent, PUBLISH.SENT);
        if (refused.length) researchLog.setPublishState(refused, PUBLISH.REJECTED);
        fails = 0;
        nextTry = 0;
        const accepted = Number(res.accepted) || 0;
        const patch = { sent: communityStatus().sent + accepted, sendError: null, authError: false };
        if (accepted) patch.lastSend = Date.now();
        if (waiting.length) { // over the daily quota: these stay PENDING, and nothing more is sent until it resets
          setCommunityStatus({ ...patch, quotaUntil: quotaResetAt(res) });
          result = 'quota';
          break;
        }
        setCommunityStatus({ ...patch, quotaUntil: 0 });
        result = 'sent';
      } catch (e) {
        if (e.auth) {
          setCommunityStatus({ authError: true, sendError: 'The server rejected the publishing token – reports are kept and will be sent once it is fixed in Settings.' });
          return 'auth';
        }
        if (e.transient) { backoff(e); return 'offline'; }
        if (built.length > 1) { size = 1; continue; } // isolate the record the server refuses
        researchLog.setPublishState(built.map(([id]) => id), PUBLISH.REJECTED);
        setCommunityStatus({ sendError: `A report was refused by the server and skipped: ${e.message}` });
      }
    }
  } catch (e) {
    if (e.transient) { backoff(e); result = 'offline'; } else if (e.auth) { setCommunityStatus({ authError: true }); result = 'auth'; } else throw e;
  } finally {
    busy = false;
    releaseLock();
    emit('community:changed');
  }
  log('publisher:', result, 'queued', queuedCount());
  return result;
}

/** Forget the back-off (connectivity came back, settings changed, user asked). */
export function resetBackoff() { fails = 0; nextTry = 0; }

/** Publish soon (coalesces bursts of new results). */
export function schedule(ms = 15000) {
  clearTimeout(timer);
  timer = setTimeout(() => flush(), researchLog.pendingCount() >= 20 ? 500 : ms);
}

/** Entries whose proposition just appeared on the community list become votes. */
function queueVotesForListed() {
  const ids = [];
  for (const [id, m] of researchLog.entries()) {
    if (m.ps === PUBLISH.NONE && m.kind === 'a' && m.pk && !m.cm && m.tc !== 'n' && knowledge.has(m.pk)) ids.push(id);
  }
  if (ids.length) researchLog.setPublishState(ids, PUBLISH.PENDING);
}

/** Wire the triggers (idempotent). */
export function startPublisher() {
  if (started) return;
  started = true;
  setTimeout(() => flush(), 1500);
  setInterval(() => flush(), 60e3);
  if (typeof window !== 'undefined') window.addEventListener('online', () => { resetBackoff(); flush(); });
  on('log:changed', () => { if (researchLog.pendingCount()) schedule(); });
  on('community:feed', queueVotesForListed);
  on('settings:changed', (prev) => {
    resetBackoff();
    const st = communityStatus();
    const patch = {};
    if (st.authError) patch.authError = false;
    if (st.quotaUntil && prev && prev.communityUrl !== settings.communityUrl) patch.quotaUntil = 0; // another server, another quota
    if (Object.keys(patch).length) setCommunityStatus(patch);
    flush();
  });
}

/** For tests / diagnostics. */
export const publisherState = () => ({ busy, fails, nextTry, queued: queuedCount(), quotaUntil: quotaHeldUntil() });
