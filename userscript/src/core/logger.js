import { settings } from './settings.js';

/** Debug logging, enabled in Settings → Advanced. */
export const log = (...a) => { if (settings.debug) console.log('[TruthAuditor]', ...a); };
