import './helpers/gm.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, diversity, fieldTokens } from '../../src/insights/clustering.js';
import { lookupDomain } from '../../src/insights/outlets.js';

const DAY = 864e5;
let n = 0;
function posts(k, outlets = [], { score = 800, comments = 150, kind = 'news' } = {}) {
  return Array.from({ length: k }, (_, i) => {
    const o = outlets.length ? lookupDomain(outlets[i % outlets.length]) : null;
    return { post: `p${++n}`, score, comments, crossposts: 1, subreddit: 'news', day: Date.now() - DAY,
      outlet: o && o.outlet, outlet_group: o && o.group, tier: o && o.tier, outlet_type: o && o.type, source_kind: o ? kind : null, url_hash: o ? `u${n}` : null };
  });
}
const point = (key, claim, p, { propTruth = 1, confidence = 1 } = {}) => ({
  key, claim, sentence: `${claim.subject} ${claim.predicate} ${claim.object}`, propTruth, confidence, posts: p, debunkPosts: [], days: p.map((x) => x.day),
});
const WHO = { subject: 'World Health Organization', predicate: 'states', object: '5G towers spread the coronavirus' };
const RAD = { subject: '5G radiation', predicate: 'causes', object: 'coronavirus symptoms' };
const CONG = { subject: 'United States Congress', predicate: 'approves', object: 'replacing the national anthem with a Nickelback song' };
const PRES = { subject: 'President', predicate: 'signs', object: 'law making a Nickelback song the national anthem' };

test('related false claims form event clusters; unrelated ones stay apart', () => {
  const res = cluster([
    point('p1_who', WHO, posts(3, ['cnn.com'])), point('p1_rad', RAD, posts(2, ['foxnews.com'])),
    point('p1_con', CONG, posts(2, ['nypost.com'])), point('p1_pre', PRES, posts(2, ['breitbart.com'])),
  ]);
  const groups = res.clusters.map((c) => c.members.map((m) => m.key).sort()).sort();
  assert.deepEqual(groups, [['p1_con', 'p1_pre'], ['p1_rad', 'p1_who']]);
});

test('a claim seen only once is not a narrative yet', () => {
  assert.equal(cluster([point('p1_who', WHO, posts(1, ['cnn.com']))]).clusters.length, 0);
  assert.equal(cluster([point('p1_who', WHO, posts(3, ['cnn.com']))]).clusters.length, 1);
});

test('accurate claims are never clustered', () => {
  assert.equal(cluster([point('p1_who', WHO, posts(5, ['cnn.com']), { propTruth: 9 })]).points, 0);
});

test('independence is counted by ownership group', () => {
  const d = (outs) => diversity(posts(outs.length, outs)).independent_sources;
  assert.equal(d(['cnn.com', 'foxnews.com', 'bbc.co.uk']), 3);
  assert.equal(d(['foxnews.com', 'foxbusiness.com']), 1);
  assert.equal(d(['wsj.com', 'nypost.com', 'thesun.co.uk']), 1);
});

test('source diversity raises severity', () => {
  const wide = cluster([point('p1_a', WHO, posts(6, ['cnn.com', 'foxnews.com', 'bbc.co.uk']))]).clusters[0];
  const narrow = cluster([point('p1_a', WHO, posts(6, ['foxnews.com', 'foxbusiness.com']))]).clusters[0];
  assert.ok(wide.severity.score > narrow.severity.score);
  assert.ok(wide.mass > narrow.mass);
});

test('popularity decides a claim\'s share of its narrative', () => {
  const res = cluster([
    point('p1_viral', WHO, posts(2, ['cnn.com'], { score: 45000, comments: 9000 })),
    point('p1_dead', RAD, posts(2, ['cnn.com'], { score: 4, comments: 1 })),
  ]);
  const c = res.clusters[0];
  assert.equal(c.most_pushed, 'p1_viral');
  assert.ok(c.members[0].share > 0.6);
});

test('field tokens keep names like 5g with their field', () => {
  const t = fieldTokens({ subject: 'World Health Organization', predicate: 'states', object: '5G towers spread COVID-19', time: '2020' });
  assert.ok(t.object.includes('5g'));
  assert.deepEqual(t.numbers, ['19', '2020']);
});
