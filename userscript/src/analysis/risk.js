/** How risky a result is, and how to label it. */
import { settings } from '../core/settings.js';
import { toneOf, harmlessJoke, satireAsFact, SATIRE_DISCOUNT } from '../text/tone.js';

/**
 * Risk used for alerts: evident satire/jokes are discounted (if enabled); satire
 * passed off as real news and decoded sarcasm keep their full risk.
 */
export function effectiveRisk(r) {
  if (!r || r.kind !== 'audit') return 0;
  if (settings.ignoreSatire && harmlessJoke(r)) return Math.round(r.risk * SATIRE_DISCOUNT);
  return r.risk;
}

export const isFlaggedResult = (r) => !!r && r.kind === 'audit' && effectiveRisk(r) >= Number(settings.riskThreshold);
export const isFlagged = (job) => !!job && job.state === 'done' && isFlaggedResult(job.result);

export function riskBand(r) {
  if (settings.ignoreSatire && harmlessJoke(r)) return 'satire';
  const x = effectiveRisk(r);
  return x >= 70 ? 'bad' : x >= 40 ? 'warn' : 'ok';
}

export function riskLabel(r) {
  if (harmlessJoke(r)) return toneOf(r) === 'humorous' ? 'Joke' : 'Likely satire';
  if (satireAsFact(r) && r.risk >= 50) return 'Satire passed off as news';
  const x = effectiveRisk(r);
  const base = x >= 70 ? 'Likely false' : x >= 50 ? 'Misleading?' : x >= 35 ? 'Unverified' : 'Looks accurate';
  return toneOf(r) === 'sarcastic' ? `Sarcasm – ${base.toLowerCase()}` : base;
}

export const toneSkipLabel = (r) => (r.tone === 'humorous' ? 'Joke' : 'Satire');

/** Truth of the AFFIRMED proposition (what the community server aggregates). */
export const propositionTruth = (r) => (r.canon && r.canon.stance === 'denies' ? 10 - r.truth : r.truth);
