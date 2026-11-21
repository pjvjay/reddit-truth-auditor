import './helpers/gm.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, similarity, urlKey } from '../../src/text/tokenize.js';
import { toneSignals } from '../../src/text/tone.js';
import { settings } from '../../src/core/settings.js';
import { effectiveRisk, riskLabel, propositionTruth } from '../../src/analysis/risk.js';
import { sourceOf } from '../../src/reddit/source.js';

const sim = (a, b) => Math.round(similarity(tokenize(a), tokenize(b)) * 100);

test('similarity guards numbers, negation and short texts', () => {
  assert.equal(sim('WHO confirms 5G towers spread the virus!!!', 'WHO confirms 5G towers spread the virus'), 100);
  assert.equal(sim('Inflation just fell to 1%, the lowest level in 50 years', 'Inflation just fell to 3%, the lowest level in 50 years'), 0);
  assert.equal(sim('The vaccine does cause autism in children', "The vaccine doesn't cause autism in children"), 0);
  assert.equal(sim('Is this real', 'Is this fake'), 0);
});

test('urlKey normalises tracking params, hosts and youtu.be', () => {
  assert.equal(urlKey('https://www.bbc.co.uk/news/article-1/?utm_source=x&fbclid=y'), 'bbc.co.uk/news/article-1');
  assert.equal(urlKey('https://youtu.be/abc123?si=share'), urlKey('https://www.youtube.com/watch?v=abc123&feature=share'));
  assert.equal(urlKey('https://www.reddit.com/r/x/comments/abc/post/'), '');
});

test('tone framing', () => {
  const f = (p) => toneSignals({ subreddit: 'news', title: '', body: '', url: '', flair: '', ...p }).frame;
  assert.equal(f({ title: 'Great, another tax hike /s' }), 'sarcasm');
  assert.equal(f({ body: 'see https://x.com/s/abc' }), 'literal');
  assert.equal(f({ subreddit: 'politics', url: 'https://www.theonion.com/x' }), 'satire-link');
  assert.equal(f({ subreddit: 'TheOnion', url: 'https://www.theonion.com/x' }), 'satire-venue');
  assert.equal(f({ subreddit: 'canada', flair: 'Meme' }), 'humour');
});

test('risk: satire discount, satire-as-fact and stance', () => {
  settings.ignoreSatire = true;
  const audit = (x) => ({ kind: 'audit', risk: 90, truth: 1, sarcasm: 9, ...x });
  assert.equal(effectiveRisk(audit({ tone: 'satirical', presentedAsFact: false })), 18);
  assert.equal(effectiveRisk(audit({ tone: 'satirical', presentedAsFact: true })), 90);
  assert.equal(riskLabel(audit({ tone: 'satirical', presentedAsFact: true })), 'Satire passed off as news');
  assert.equal(propositionTruth({ truth: 9, canon: { stance: 'denies' } }), 1);
});

test('sourceOf detects article kinds and never returns a path', () => {
  assert.deepEqual(sourceOf({ url: 'https://edition.cnn.com/2026/02/20/health/x/index.html' }), { domain: 'edition.cnn.com', kind: 'news' });
  assert.equal(sourceOf({ url: 'https://www.theguardian.com/commentisfree/2026/x' }).kind, 'opinion');
  assert.equal(sourceOf({ url: 'https://x.com/a/status/1' }).kind, 'social');
  assert.equal(sourceOf({ url: 'https://i.redd.it/a.jpg' }), null);
  assert.equal(sourceOf({ url: '' }), null);
});
