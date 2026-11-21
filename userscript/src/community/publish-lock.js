/**
 * Keeps two tabs from publishing the same queued reports at the same time.
 *
 * Two layers, because neither covers every case on its own:
 *
 *   1. Web Locks (navigator.locks) - exclusive, but only between tabs on the
 *      same Reddit host: the lock manager belongs to the origin, so
 *      www.reddit.com and old.reddit.com do not share one. The browser frees
 *      the lock when the work ends or the tab goes away.
 *   2. A lease in the userscript manager's storage, which every host shares.
 *      Best effort only: it is a read followed by a write, and managers cache
 *      values per tab, so two tabs that start in the same instant can both
 *      take it.
 *
 * So a simultaneous duplicate send is prevented between tabs on the same host
 * where the browser has Web Locks, and only made unlikely otherwise. A
 * duplicate that gets through does no harm: the server stores a report once
 * and does not count repeats against the sender's daily quota.
 */
export const LOCKED = 'locked';
const WEB_LOCK = 'rta.community.publish';

/**
 * @param storage  { get, set, remove } - the userscript manager's shared storage
 * @param locks    () => LockManager | null - navigator.locks where available
 * @param key      storage key of the lease
 * @param tab      this tab's id
 * @param leaseMs  how long a lease lasts unless renewed (a crashed tab must not block the others for long)
 */
export function createPublishLock({ storage, locks, key, tab = Math.random().toString(36).slice(2), leaseMs = 60e3 }) {
  function takeLease() {
    const held = storage.get(key, null);
    if (held && held.owner !== tab && held.until > Date.now()) return false;
    storage.set(key, { owner: tab, until: Date.now() + leaseMs });
    const now = storage.get(key, null);
    return !!now && now.owner === tab;
  }

  function dropLease() {
    const held = storage.get(key, null);
    if (held && held.owner === tab) storage.remove(key);
  }

  async function withLease(fn) {
    if (!takeLease()) return LOCKED;
    try { return await fn(); } finally { dropLease(); }
  }

  return {
    /** Run fn while holding the lock. Resolves to LOCKED, without running fn, if another tab holds it. */
    async run(fn) {
      const manager = locks();
      if (!manager) return withLease(fn);
      let answered = false;
      try {
        return await manager.request(WEB_LOCK, { ifAvailable: true }, (lock) => {
          answered = true;
          return lock ? withLease(fn) : LOCKED;
        });
      } catch (e) {
        if (answered) throw e; //   fn failed - not the lock
        return withLease(fn); //    the browser refused Web Locks here (e.g. a SecurityError): lease only
      }
    },

    /** Extend the lease during a long run. False if another tab has taken it over meanwhile. */
    renew: takeLease,
  };
}
