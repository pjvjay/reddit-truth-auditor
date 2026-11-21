/** User settings: defaults, persistence, change notification. */
import { storage } from './env.js';
import { emit } from './events.js';
import { clampNum } from './util.js';

/** Every storage key the script uses (all prefixed "rta."). */
export const KEYS = {
  settings: 'rta.settings',
  welcomed: 'rta.welcomed',
  index: 'rta.idx',               // research-log index (compact, one array per post)
  logPrefix: 'rta.log.',          // research-log records, one key per post
  usage: 'rta.usage',             // today's spend / counters
  stats: 'rta.stats',             // lifetime savings counters
  clientId: 'rta.clientId',       // anonymous community id
  feed: 'rta.community',          // cached community feed
  trends: 'rta.community.trends', // cached community clusters
  commStatus: 'rta.community.status',
  lastPayload: 'rta.community.lastPayload',
  legacyCache: 'rta.cache',       // v1.0 cache (migrated)
  legacyOutbox: 'rta.outbox',     // v1.3-1.4 outbox (drained by the publisher)
};

export const DEFAULTS = Object.freeze({
  // language model
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  priceInPerM: 0.15, // USD per 1M input tokens (gpt-4o-mini)
  priceOutPerM: 0.60,
  // web research
  tavilyKey: '',
  // alerts
  riskThreshold: 60, // panel opens when risk >= this (60 == truth <= 4/10)
  autoOpen: 'risky', // 'risky' | 'always' | 'never'
  inlineBadges: true,
  ignoreSatire: true, // evident satire/jokes are harmless unless passed off as real news
  skipSatireVenues: true, // no API call in dedicated satire subreddits
  satireCutoff: 7, // satire score >= this counts as non-literal (records without "tone")
  // scanning & cost
  dwellMs: 1200,
  maxConcurrent: 2,
  dailyBudgetUsd: 0.5, // 0 = unlimited
  subsAllow: '',
  subsBlock: '',
  referenceFacts: '',
  // research log & duplicates
  logDays: 30,
  maxLogEntries: 5000,
  dedupe: true,
  dupThreshold: 80, // 50-100 word-overlap similarity
  // community network (opt-in)
  communityEnabled: false,
  communityUrl: '',
  communityToken: '',
  shareReports: true,
  shareSubreddit: true,
  shareBacklog: true, // also publish analyses made while offline / before joining
  useCommunity: true,
  communityMinClients: 3,
  communitySyncHours: 6,
  // misc
  paused: false,
  debug: false,
});

/** The live settings object. Always mutated in place so importers keep a valid reference. */
export const settings = { ...DEFAULTS };

export function loadSettings() {
  const raw = storage.get(KEYS.settings, {});
  Object.assign(settings, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  return settings;
}

export function saveSettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, patch);
  storage.set(KEYS.settings, { ...settings });
  emit('settings:changed', prev);
}

/** Word-overlap similarity (0.5-1) needed for two posts/claims to count as duplicates. */
export const dupThreshold = () => clampNum(settings.dupThreshold, 50, 100, 80) / 100;
