import { store, resetGM } from './helpers/gm.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { researchLog, PUBLISH } from '../../src/store/research-log.js';
import { settings, KEYS, DEFAULTS } from '../../src/core/settings.js';

const post = (id, title) => ({ id, title, subreddit: 'news', permalink: `/r/news/comments/${id.slice(3)}/x/`, url: '', body: '' });
const audit = (title, truth = 1) => ({ kind: 'audit', truth, risk: (10 - truth) * 10, sarcasm: 0, tone: 'sincere', claim: title, at: Date.now(), post: { title, subreddit: 'news' } });

beforeEach(() => {
  resetGM();
  Object.assign(settings, DEFAULTS);
  researchLog.idx = null;
  researchLog.deleted.clear();
  researchLog.load();
});

test('stores results and tracks publish state', () => {
  researchLog.put('t3_a', audit('A false claim about things'), post('t3_a', 'A false claim about things'), { publishable: true });
  researchLog.put('t3_b', audit('An accurate claim', 9), post('t3_b', 'An accurate claim'));
  assert.equal(researchLog.get('t3_a').claim, 'A false claim about things');
  assert.deepEqual(researchLog.pending().map(([id]) => id), ['t3_a']);
  researchLog.setPublishState(['t3_a'], PUBLISH.SENT);
  assert.equal(researchLog.pendingCount(), 0);
  assert.equal(store.get(`${KEYS.logPrefix}t3_a`).ps, PUBLISH.SENT, 'state persisted with the record');
});

test('pending survives a reload (new tab / browser restart)', () => {
  researchLog.put('t3_a', audit('Claim one here'), post('t3_a', 'Claim one here'), { publishable: true });
  researchLog.flush();
  researchLog.idx = null; // simulate a fresh page
  assert.equal(researchLog.pendingCount(), 1);
});

test('index merge keeps the most advanced publish state from another tab', () => {
  researchLog.put('t3_a', audit('Claim one here'), post('t3_a', 'Claim one here'), { publishable: true });
  researchLog.saveIndex();
  // another tab publishes it and saves the index (publish state is the last field)
  const idx = store.get(KEYS.index);
  idx.t3_a[idx.t3_a.length - 1] = PUBLISH.SENT;
  store.set(KEYS.index, idx);
  researchLog.saveIndex(); // this tab still thinks it is pending
  assert.equal(researchLog.pendingCount(), 0);
});

test('reconciles records whose index entry was lost', () => {
  store.set(`${KEYS.logPrefix}t3_z`, { t: Date.now(), r: audit('Orphaned record claim'), ps: PUBLISH.PENDING });
  researchLog.idx = null;
  assert.equal(researchLog.size(), 1);
  assert.equal(researchLog.pendingCount(), 1);
});

test('retention prunes old entries', () => {
  store.set(`${KEYS.logPrefix}t3_old`, { t: Date.now() - 40 * 864e5, r: audit('Old claim from long ago') });
  researchLog.idx = null;
  assert.equal(researchLog.size(), 0);
  assert.equal(store.has(`${KEYS.logPrefix}t3_old`), false);
});

test('duplicate detection respects tone framing', () => {
  researchLog.put('t3_a', audit('WHO confirms 5G towers spread the virus'), post('t3_a', 'WHO confirms 5G towers spread the virus'));
  const dup = researchLog.findSimilarPost(post('t3_b', 'WHO confirms 5G towers spread the virus!!'));
  assert.equal(dup && dup.via, 'text');
  assert.equal(researchLog.findSimilarPost(post('t3_c', 'WHO confirms 5G towers spread the virus /s')), null);
});
