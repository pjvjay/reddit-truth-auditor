/**
 * Reddit Truth Auditor - entry point.
 *
 * Wires the modules together:
 *   scanner (dwell) -> pipeline (jobs) -> research log (local, offline-first)
 *                                      -> community publisher (when reachable)
 *   UI subscribes to events emitted by the core.
 */
import { registerMenuCommand, storage, scriptVersion } from './core/env.js';
import { settings, loadSettings, KEYS } from './core/settings.js';
import { on, emit } from './core/events.js';
import { log } from './core/logger.js';
import { researchLog } from './store/research-log.js';
import { knowledge } from './community/knowledge.js';
import { communityConfigured } from './community/config.js';
import { startPublisher, flush, queuedCount } from './community/publisher.js';
import { onDwell, reevaluateAll, runtime } from './pipeline/jobs.js';
import { startScanner, rearm } from './pipeline/scanner.js';
import { initPanel, open, toggle } from './ui/panel.js';
import { showSettings } from './ui/settings-view.js';
import * as testApi from './testing.js';

function startCommunity() {
  knowledge.sync(false); // immediately - only downloads when the cached list is stale
  setInterval(() => { if (communityConfigured()) knowledge.sync(false); }, 60e3);
  if (typeof window !== 'undefined') window.addEventListener('online', () => knowledge.sync(false));
}

function boot() {
  loadSettings();
  researchLog.init();
  knowledge.load();
  initPanel();
  startScanner(onDwell);
  startPublisher();
  startCommunity();

  on('settings:changed', () => {
    runtime.halted = null;
    reevaluateAll();
    rearm();
  });

  registerMenuCommand('Open Truth Auditor panel', () => open('menu'));
  registerMenuCommand('Settings…', () => showSettings());
  registerMenuCommand('Publish queued community reports', () => flush({ force: true }));
  registerMenuCommand('Toggle panel (Alt+Shift+R)', () => toggle());

  if (!settings.apiKey && !storage.get(KEYS.welcomed, false)) {
    storage.set(KEYS.welcomed, true);
    setTimeout(() => showSettings(), 600);
  }
  emit('status:changed');
  log('ready', scriptVersion(), '- queued reports:', queuedCount());
}

if (!window.__RTA_LOADED__) {
  window.__RTA_LOADED__ = true;
  // Opt-in hooks for the automated test-suite (the flag is never set on real pages).
  if (window.__RTA_TEST_HOOKS__) window.__RTA_TEST__ = testApi;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
