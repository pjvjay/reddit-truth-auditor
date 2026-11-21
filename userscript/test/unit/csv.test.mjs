import { resetGM } from './helpers/gm.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchLog } from '../../src/store/research-log.js';
import { toCsv } from '../../src/ui/export.js';

test('CSV export neutralises spreadsheet formulas and quotes everything', () => {
  resetGM();
  researchLog.idx = null;
  const r = { kind: 'audit', truth: 1, risk: 90, sarcasm: 0, tone: 'sincere', confidence: 'high', claim: '=HYPERLINK("http://evil")',
    verdict: 'He said "no"', sources: [], at: Date.now(), post: { title: '+cmd|calc', subreddit: 'news', permalink: '/r/news/comments/a/x/' } };
  researchLog.put('t3_a', r, { title: r.post.title, subreddit: 'news' });
  const [header, row] = toCsv().split('\r\n');
  assert.ok(header.startsWith('date,post_id,risk,truth_score'));
  assert.ok(row.includes(`"'+cmd|calc"`), 'formula prefix neutralised');
  assert.ok(row.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(row.includes('"He said ""no"""'));
});
