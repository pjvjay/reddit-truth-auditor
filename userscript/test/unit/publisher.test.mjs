// Offline-first publishing: analyses are stored locally and published whenever the server is reachable.
import { respond, resetGM, requests, store, tick } from './helpers/gm.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings, DEFAULTS, KEYS } from '../../src/core/settings.js';
import { researchLog, PUBLISH } from '../../src/store/research-log.js';
import { buildCanon } from '../../src/text/canonical.js';
import { isReportable, reportContext, buildReport, flush, queuedCount, resetBackoff } from '../../src/community/publisher.js';
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
