/**
 * Internals exposed to the end-to-end test-suite via window.__RTA_TEST__ - only
 * when the page sets window.__RTA_TEST_HOOKS__ before the script runs.
 */
export { tokenize, similarity, urlKey, postTokens } from './text/tokenize.js';
export { toneSignals } from './text/tone.js';
export { canonicalize, hashRef } from './text/canonical.js';
export { effectiveRisk } from './analysis/risk.js';
export { sourceOf } from './reddit/source.js';
export { researchLog as Log, PUBLISH } from './store/research-log.js';
export { knowledge as Community } from './community/knowledge.js';
export { communityStatus } from './community/config.js';
export { localNarratives } from './insights/local-narratives.js';
import { flush, queuedCount, publisherState } from './community/publisher.js';

/** Back-compat shape used by the e2e tests: Reporter.flush(force) / pending() / busy. */
export const Reporter = {
  flush: (force) => flush({ force: !!force }),
  pending: () => queuedCount(),
  get busy() { return publisherState().busy; },
};
