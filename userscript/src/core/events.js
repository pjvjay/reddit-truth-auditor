/**
 * Minimal synchronous event bus. Core modules emit, the UI subscribes - so
 * business logic never imports UI code.
 *
 * Events:
 *   job:update (job)        a job's state / result changed
 *   job:removed (id)
 *   job:alert (job)         a newly flagged post that should surface the panel
 *   job:visible (id, bool)  a post's on-screen state changed
 *   log:changed ()          research log entries added / removed
 *   usage:changed ()
 *   community:changed ()    feed / publisher / connectivity status changed
 *   status:changed ()       queue / halt / pause state changed
 *   settings:changed (prev) settings were saved
 *   ui:open (reason)        something wants the panel open
 *   ui:banners ()           banner conditions changed
 */
const handlers = new Map();

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event).delete(fn);
}

export function emit(event, ...args) {
  for (const fn of handlers.get(event) || []) {
    try { fn(...args); } catch (e) { console.error('[TruthAuditor] listener failed', event, e); }
  }
}
