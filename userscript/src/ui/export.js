/** CSV export of the research log (columns of the original finalrun.py audit CSV, plus extras). */
import { localDay } from '../core/util.js';
import { toneOf, isNonLiteral } from '../text/tone.js';
import { effectiveRisk } from '../analysis/risk.js';
import { researchLog, PUBLISH } from '../store/research-log.js';

const COLUMNS = ['date', 'post_id', 'risk', 'truth_score', 'sarcasm_score', 'confidence', 'subreddit', 'title', 'claim', 'factual_check',
  'context_check', 'verdict', 'sources', 'url', 'reused_from', 'reuse_via', 'tone', 'presented_as_fact', 'effective_risk',
  'proposition_key', 'stance', 'canonical_claim', 'publish_state'];
const PUBLISH_NAMES = { [PUBLISH.NONE]: '', [PUBLISH.PENDING]: 'pending', [PUBLISH.SENT]: 'sent', [PUBLISH.REJECTED]: 'rejected' };

/** Quote a cell; prefix values that spreadsheets would execute as formulas. */
function cell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv() {
  const rows = researchLog.entries()
    .map(([id, m]) => [id, m, researchLog.get(id)])
    .filter(([, , r]) => r && r.kind === 'audit')
    .map(([id, m, r]) => {
      const p = r.post || {};
      const d = r.dupOf || (r.community ? { id: r.community.key, via: `community-${r.community.via}` } : {});
      return [new Date(r.at).toISOString(), id, r.risk, r.truth, r.sarcasm, r.confidence, p.subreddit, p.title, r.claim, r.factualCheck,
        r.contextCheck, r.verdict, (r.sources || []).map((x) => x.url).join(' '), p.permalink ? `https://www.reddit.com${p.permalink}` : '',
        d.id || '', d.via || '', toneOf(r), isNonLiteral(r) ? String(!!r.presentedAsFact) : '', effectiveRisk(r),
        r.canon ? r.canon.key : '', r.canon ? r.canon.stance : '', r.canon ? r.canon.sentence : '', PUBLISH_NAMES[m.ps] || ''].map(cell).join(',');
    });
  return [COLUMNS.join(','), ...rows].join('\r\n');
}

export function downloadCsv() {
  const url = URL.createObjectURL(new Blob([`\ufeff${toCsv()}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `reddit-truth-audit-${localDay()}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
