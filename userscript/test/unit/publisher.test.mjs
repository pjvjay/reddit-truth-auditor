// Offline-first publishing: analyses are stored locally and published whenever the server is reachable.
import { respond, resetGM, requests, store, tick } from './helpers/gm.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings, DEFAULTS, KEYS } from '../../src/core/settings.js';
import { researchLog, PUBLISH } from '../../src/store/research-log.js';
import { buildCanon } from '../../src/text/canonical.js';
import { isReportable, reportContext, buildReport, flush, queuedCount, resetBackoff, quotaNotice, quotaHeldUntil } from '../../src/community/publisher.js';
import { communityStatus } from '../../src/community/config.js';

const WHO = { subject: 'World Health Organization', predicate: 'states', object: '5G towers spread the coronavirus', polarity: 'affirms', topic: 'health' };
let n = 0;

async function analysed({ truth = 1, tone = 'sincere', paf = false, canon = WHO, seenDaysAgo = 0, ctx = {} } = {}) {
  const id = `t3_p${++n}`;
  const post = { id, title: `Post ${n} about 5G`, subreddit: 'worldnews', permalink: `/r/worldnews/comments/p${n}/x/`, body: '',
    url: 'https://edition.cnn.com/2026/02/20/health/5g/index.html', engagement: { score: 1200, comments: 300, crossposts: 2 }, createdUtc: Date.now() / 1000 - 3600 };
  const r = { kind: 'audit', truth, risk: Math.round((10 - truth) * 10), sarcasm: 0, tone, presentedAsFact: paf, confidence: 'high', claim: 'x',
    verdict: 'False.', sources: [{ url: 'https://www.reuters.com/fact-check/x' }], model: 'm', at: Date.now(), researched: true,
    post: { title: post.title, subreddit: 'worldnews', permalink: post.permalink, url: post.url }, canon: canon && await buildCanon(canon), origin: 'audit' };
  r.report = { ...reportContext(post), ...ctx };
  if (seenDaysAgo) r.report.seen_day = new Date(Date.now() - seenDaysAgo * 864e5).toISOString().slice(0, 10);
  researchLog.put(id, r, post, { publishable: isReportable(r) });
  return id;
}

const accept = (req) => ({ status: 200, json: { accepted: JSON.parse(req.data).reports.length, rejected: [] } });

/**
 * A server with a daily quota, answering the way rta_server does: reports over the
 * quota are rejected one by one inside a 200. `codes: false` imitates a v2.0.0 server,
 * which gives only the reason text and no quota block. Set `.used = 0` for a new day.
 */
function quotaServer(limit, { codes = true, resetsAt = () => Date.now() + 3600e3 } = {}) {
  const server = { used: 0 };
  respond((req) => {
    const rejected = [];
    let accepted = 0;
    JSON.parse(req.data).reports.forEach((_, index) => {
      if (server.used < limit) { server.used++; accepted++; }
      else rejected.push({ index, ...(codes ? { code: 'quota' } : {}), reason: 'daily quota exceeded' });
    });
    const json = { accepted, rejected };
    if (codes) json.quota = { limit, used: server.used, remaining: limit - server.used, resets_at: Math.floor(resetsAt() / 1000) };
    return { status: 200, json };
  });
  return server;
}
const states = (ids) => ids.map((id) => researchLog.idx.get(id).ps);

beforeEach(() => {
  resetGM();
  Object.assign(settings, DEFAULTS, { communityEnabled: true, communityUrl: 'https://community.test', shareReports: true });
  researchLog.idx = null;
  researchLog.load();
  resetBackoff();
});

test('what is reportable', async () => {
  const mistruth = researchLog.get(await analysed());
  assert.ok(isReportable(mistruth));
  assert.ok(!isReportable(researchLog.get(await analysed({ truth: 9 }))), 'accurate claims are not reported');
  assert.ok(!isReportable(researchLog.get(await analysed({ tone: 'satirical', paf: false }))), 'evident jokes are never reported');
  assert.ok(isReportable(researchLog.get(await analysed({ tone: 'satirical', paf: true }))), 'satire passed off as fact is');
  assert.ok(!isReportable(researchLog.get(await analysed({ canon: null }))), 'needs a canonical claim');
});

test('reports contain only documented fields - no title, path or raw id', async () => {
  const id = await analysed();
  const rep = await buildReport(id, researchLog.get(id));
  assert.deepEqual(Object.keys(rep).sort(), ['attributed', 'claim', 'claim_truth', 'confidence', 'day', 'engagement', 'key', 'model', 'origin', 'post', 'post_day',
    'presented_as_fact', 'researched', 'source', 'sources', 'subreddit', 'tone', 'url_hash', 'verdict'].sort());
  const blob = JSON.stringify(rep);
  for (const secret of ['t3_', 'Post ', '/comments/', 'index.html', '/health/']) assert.ok(!blob.includes(secret), secret);
  assert.deepEqual(rep.source, { domain: 'edition.cnn.com', kind: 'news' });
  assert.match(rep.post, /^[0-9a-f]{32}$/);
});

test('analysed without any community configured -> queued locally, published after joining', async () => {
  Object.assign(settings, { communityEnabled: false, communityUrl: '' });
  await analysed();
  await analysed();
  assert.equal(await flush(), 'disabled');
  assert.equal(requests.length, 0, 'nothing leaves the browser before joining');
  assert.equal(researchLog.pendingCount(), 2, 'kept in the research log');

  Object.assign(settings, { communityEnabled: true, communityUrl: 'https://community.test', communityJoinedAt: Date.now() });
  respond(accept);
  assert.equal(await flush(), 'sent');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.reports.length, 2);
  assert.equal(researchLog.pendingCount(), 0);
  assert.equal(communityStatus().sent, 2);
});

test('shareBacklog=false only shares analyses made after joining', async () => {
  await analysed(); // before joining
  Object.assign(settings, { shareBacklog: false, communityJoinedAt: Date.now() + 1 });
  await tick(5);
  const after = await analysed();
  respond(accept);
  await flush();
  assert.equal(requests[0].body.reports.length, 1);
  assert.equal(researchLog.get(after) && researchLog.pending().length, 1, 'the older one stays queued, not sent');
});

test('server unreachable -> kept, backed off, then delivered when it is back', async () => {
  await analysed();
  respond(() => ({ network: true }));
  assert.equal(await flush(), 'offline');
  assert.equal(researchLog.pendingCount(), 1);
  assert.equal(communityStatus().online, false);
  assert.equal(await flush(), 'backoff', 'not hammering the server');
  respond(accept);
  assert.equal(await flush({ force: true }), 'sent');
  assert.equal(researchLog.pendingCount(), 0);
  assert.equal(communityStatus().online, true);
});

test('5xx and 429 are transient too', async () => {
  await analysed();
  respond(() => ({ status: 503, json: { detail: 'maintenance' } }));
  assert.equal(await flush(), 'offline');
  respond(() => ({ status: 429, json: { detail: 'slow down' } }));
  assert.equal(await flush({ force: true }), 'offline');
  assert.equal(researchLog.pendingCount(), 1);
});

test('rejected token pauses publishing without losing anything', async () => {
  await analysed();
  respond(() => ({ status: 401, json: { detail: 'Missing or invalid X-RTA-Token' } }));
  assert.equal(await flush(), 'auth');
  assert.equal(communityStatus().authError, true);
  assert.equal(await flush(), 'auth', 'paused until the settings change');
  assert.equal(researchLog.pendingCount(), 1);
  settings.communityToken = 'fixed';
  respond((req) => (req.headers['X-RTA-Token'] === 'fixed' ? accept(req) : { status: 401, json: {} }));
  assert.equal(await flush({ force: true }), 'sent');
});

test('a record the server refuses is isolated and skipped; the rest are delivered', async () => {
  const bad = await analysed();
  await analysed();
  await analysed();
  respond((req) => {
    const reps = JSON.parse(req.data).reports;
    return reps.length > 1 ? { status: 422, json: { detail: 'invalid' } } : accept(req);
  });
  assert.equal(await flush(), 'sent');
  // 422 on the batch -> retried one by one: all three accepted individually in this scenario
  assert.equal(researchLog.pendingCount(), 0);
  respond(() => ({ status: 422, json: { detail: 'bad record' } }));
  const bad2 = await analysed();
  await flush({ force: true });
  assert.equal(researchLog.idx.get(bad2).ps, PUBLISH.REJECTED, 'never retried automatically');
  assert.ok(researchLog.idx.get(bad).ps === PUBLISH.SENT);
});

test('per-report rejections from a 200 response are recorded', async () => {
  const a = await analysed();
  const b = await analysed();
  respond(() => ({ status: 200, json: { accepted: 1, rejected: [{ index: 1, reason: 'joke' }] } }));
  await flush();
  assert.equal(researchLog.idx.get(a).ps, PUBLISH.SENT);
  assert.equal(researchLog.idx.get(b).ps, PUBLISH.REJECTED);
});

test('reports over the daily quota stay queued, the user is told, and they are sent after the quota resets', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await analysed());
  const reset = (Math.floor(Date.now() / 1000) + 6 * 3600) * 1000; // the server gives whole seconds
  const server = quotaServer(5, { resetsAt: () => reset });

  assert.equal(await flush(), 'quota');
  const { SENT, PENDING } = PUBLISH;
  assert.deepEqual(states(ids), [SENT, SENT, SENT, SENT, SENT, PENDING, PENDING, PENDING], 'the three over the quota are still queued, not rejected');
  assert.equal(queuedCount(), 3);
  assert.equal(communityStatus().sent, 5);
  assert.equal(quotaHeldUntil(), reset + 60e3, 'held until the reset the server gave, plus a minute of slack');
  assert.match(quotaNotice(), /^Daily sharing limit reached – 3 reports kept and will be sent automatically after \S/);

  // while held, the timer and new results do not hammer the server; "Publish now" asks once and is told the same
  assert.equal(await flush(), 'quota');
  assert.equal(requests.length, 1);
  assert.equal(await flush({ force: true }), 'quota');
  assert.equal(requests.length, 2);
  assert.equal(queuedCount(), 3);

  // the next day
  t.mock.timers.setTime(reset + 61e3);
  server.used = 0;
  assert.equal(quotaHeldUntil(), 0);
  assert.equal(await flush(), 'sent');
  assert.equal(requests[2].body.reports.length, 3, 'exactly the three that were held');
  assert.deepEqual(states(ids), ids.map(() => SENT));
  assert.equal(communityStatus().sent, 8);
  assert.equal(communityStatus().quotaUntil, 0);
  assert.equal(quotaNotice(), null);
});

test('a quota rejection is told apart from an invalid report in the same response', async () => {
  const ids = [await analysed(), await analysed(), await analysed()];
  respond(() => ({ status: 200, json: { accepted: 1, quota: { limit: 1, used: 1, remaining: 0, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    rejected: [{ index: 1, code: 'invalid', reason: 'claim has no subject/object' }, { index: 2, code: 'quota', reason: 'daily quota exceeded' }] } }));
  assert.equal(await flush(), 'quota');
  assert.deepEqual(states(ids), [PUBLISH.SENT, PUBLISH.REJECTED, PUBLISH.PENDING]);
});

test('a v2.0.0 server that only says "daily quota exceeded" is understood: held until the next UTC midnight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 21, 15, 0, 0) });
  const ids = [await analysed(), await analysed()];
  quotaServer(1, { codes: false });
  assert.equal(await flush(), 'quota');
  assert.deepEqual(states(ids), [PUBLISH.SENT, PUBLISH.PENDING]);
  assert.equal(quotaHeldUntil(), Date.UTC(2026, 10, 22, 0, 1, 0));
});

test('a reset time far in the future cannot park the queue: it is tried again within about a day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await analysed();
  quotaServer(0, { resetsAt: () => Date.now() + 400 * 864e5 });
  assert.equal(await flush(), 'quota');
  assert.ok(quotaHeldUntil() <= Date.now() + 25 * 3600e3 + 60e3);
});

test('legacy outbox entries over the quota are kept as well', async () => {
  store.set(KEYS.legacyOutbox, [1, 2, 3].map((i) => ({ _id: `x${i}`, claim: WHO, key: 'p1_x', claim_truth: 1, post: String(i).repeat(32) })));
  quotaServer(2);
  assert.equal(await flush(), 'quota');
  assert.deepEqual(store.get(KEYS.legacyOutbox).map((x) => x._id), ['x3']);
  assert.equal(queuedCount(), 1);
  assert.ok(quotaHeldUntil() > Date.now());
});

test('reports carry the day the post was SEEN, not the day they were published', async () => {
  const id = await analysed({ seenDaysAgo: 5 });
  const rep = await buildReport(id, researchLog.get(id));
  assert.equal(rep.day, new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10));
});

test('legacy v1.3 outbox is drained first', async () => {
  store.set(KEYS.legacyOutbox, [{ _id: 'x', claim: WHO, key: 'p1_x', claim_truth: 1, post: 'a'.repeat(32) }]);
  respond(accept);
  assert.equal(queuedCount(), 1);
  await flush();
  assert.equal(requests[0].body.reports[0].claim_truth, 1);
  assert.equal(requests[0].body.reports[0]._id, undefined, 'internal ids are not sent');
  assert.equal(store.has(KEYS.legacyOutbox), false);
});

test('another tab holding the publish lock -> this tab waits', async () => {
  await analysed();
  store.set('rta.community.publishLock', { owner: 'other-tab', until: Date.now() + 60e3 });
  respond(accept);
  assert.equal(await flush(), 'locked');
  store.set('rta.community.publishLock', { owner: 'other-tab', until: Date.now() - 1 }); // expired
  assert.equal(await flush(), 'sent');
});
