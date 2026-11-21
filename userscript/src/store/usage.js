/** Today's spend & counters (daily budget) and lifetime savings statistics. */
import { storage } from '../core/env.js';
import { settings, KEYS } from '../core/settings.js';
import { emit } from '../core/events.js';
import { localDay } from '../core/util.js';

export function getUsage() {
  const u = storage.get(KEYS.usage, null);
  return u && u.day === localDay() ? u : { day: localDay(), usd: 0, llmCalls: 0, searches: 0, checks: 0 };
}

export function addUsage(delta) {
  const u = getUsage();
  for (const [k, v] of Object.entries(delta)) u[k] = (u[k] || 0) + v;
  storage.set(KEYS.usage, u);
  emit('usage:changed');
  return u;
}

/** USD left under today's cap (Infinity when uncapped). */
export function budgetLeft() {
  const b = Number(settings.dailyBudgetUsd) || 0;
  return b <= 0 ? Infinity : b - getUsage().usd;
}

const STAT_DEFAULTS = { revisits: 0, dupHits: 0, claimHits: 0, toneSkips: 0, communityHits: 0, savedUsd: 0, savedSearches: 0, fullChecks: 0, fullUsd: 0, extractChecks: 0, extractUsd: 0 };

/** Lifetime counters (shown in the History tab). */
export function getStats() {
  const s = storage.get(KEYS.stats, null);
  return { ...STAT_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
}

export function addStats(delta) {
  const st = getStats();
  for (const [k, v] of Object.entries(delta)) st[k] = (st[k] || 0) + v;
  storage.set(KEYS.stats, st);
  return st;
}

/**
 * Record the tokens a shortcut saved, estimated from this user's own average costs.
 * kinds: revisit | dup | claim | tone-venue | tone-model | community | community-link
 */
export function recordSaving(kind) {
  const st = getStats();
  const avgFull = st.fullChecks ? st.fullUsd / st.fullChecks : 0.0005;
  const avgExtract = st.extractChecks ? st.extractUsd / st.extractChecks : 0.0001;
  const afterExtract = Math.max(0, avgFull - avgExtract);
  const search = settings.tavilyKey ? 1 : 0;
  const table = {
    revisit: [{ revisits: 1 }, avgFull, true],
    dup: [{ dupHits: 1 }, avgFull, true],
    claim: [{ claimHits: 1 }, afterExtract, true],
    'tone-venue': [{ toneSkips: 1 }, avgFull, false],
    'tone-model': [{ toneSkips: 1 }, afterExtract, false],
    community: [{ communityHits: 1 }, afterExtract, false],
    'community-link': [{ communityHits: 1 }, avgFull, false],
  };
  const [counter, usd, countsAsReuse] = table[kind] || table.dup;
  addStats({ ...counter, savedUsd: usd, savedSearches: search });
  if (countsAsReuse) addUsage({ reused: 1 });
}
