// The cross-tab publish lock: what it guarantees, and where it is only best effort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublishLock, LOCKED } from '../../src/community/publish-lock.js';

const KEY = 'rta.community.publishLock';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Userscript-manager storage in which every tab sees every write at once. */
function sharedStorage() {
  const m = new Map();
  return { m, get: (k, d) => (m.has(k) ? structuredClone(m.get(k)) : d), set: (k, v) => { m.set(k, structuredClone(v)); }, remove: (k) => { m.delete(k); } };
}

/**
 * The worst case of per-tab value caches: in the instant two tabs start together,
 * neither has seen the other's write yet, so each tab reads back only its own.
 */
const cachedPerTab = () => sharedStorage();

/** navigator.locks as far as the lock uses it: request(name, { ifAvailable: true }, callback). */
function lockManager() {
  const held = new Set();
  return {
    held,
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  };
}

/** Two tabs start publishing in the same instant; returns what each got and how many ran at the same time. */
async function race(tabA, tabB) {
  let running = 0, most = 0;
  const work = async () => { most = Math.max(most, ++running); await tick(5); running--; return 'sent'; };
  const results = await Promise.all([tabA.run(work), tabB.run(work)]);
  return { results: results.sort(), most };
}

test('same host: Web Locks let exactly one of two tabs publish, even when neither sees the other\'s lease', async () => {
  const locks = lockManager(); // one manager: both tabs are on www.reddit.com
  const a = createPublishLock({ storage: cachedPerTab(), locks: () => locks, key: KEY, tab: 'a' });
  const b = createPublishLock({ storage: cachedPerTab(), locks: () => locks, key: KEY, tab: 'b' });
  assert.deepEqual(await race(a, b), { results: [LOCKED, 'sent'], most: 1 });
  assert.equal(locks.held.size, 0, 'released afterwards');
  assert.equal(await b.run(async () => 'sent'), 'sent', 'the tab that waited gets its turn');
});

test('the runtime\'s own navigator.locks behaves the same', { skip: !(globalThis.navigator && globalThis.navigator.locks) }, async () => {
  const locks = () => globalThis.navigator.locks;
  const a = createPublishLock({ storage: cachedPerTab(), locks, key: KEY, tab: 'a' });
  const b = createPublishLock({ storage: cachedPerTab(), locks, key: KEY, tab: 'b' });
  assert.deepEqual(await race(a, b), { results: [LOCKED, 'sent'], most: 1 });
});

test('different hosts or no Web Locks: the storage lease holds once a tab can see the other\'s write', async () => {
  const storage = sharedStorage();
  const a = createPublishLock({ storage, locks: () => null, key: KEY, tab: 'a' });
  const b = createPublishLock({ storage, locks: () => null, key: KEY, tab: 'b' });
  assert.deepEqual(await race(a, b), { results: [LOCKED, 'sent'], most: 1 });
  assert.equal(storage.m.has(KEY), false, 'lease removed afterwards');
});

test('the storage lease alone is best effort: two tabs starting in the same instant can both publish', async () => {
  // This is why Web Locks come first, why the docs do not promise "never", and why the server
  // stores a repeated report once and does not count it against the quota.
  const a = createPublishLock({ storage: cachedPerTab(), locks: () => null, key: KEY, tab: 'a' });
  const b = createPublishLock({ storage: cachedPerTab(), locks: () => null, key: KEY, tab: 'b' });
  assert.deepEqual(await race(a, b), { results: ['sent', 'sent'], most: 2 });
});

test('a lease left by a crashed tab expires; a live one can be renewed, and a lost one cannot', async () => {
  const storage = sharedStorage();
  const a = createPublishLock({ storage, locks: () => null, key: KEY, tab: 'a', leaseMs: 20 });
  const b = createPublishLock({ storage, locks: () => null, key: KEY, tab: 'b', leaseMs: 20 });
  storage.set(KEY, { owner: 'crashed', until: Date.now() + 15 });
  assert.equal(await a.run(async () => 'sent'), LOCKED);
  await tick(25);
  assert.equal(await a.run(async () => {
    assert.equal(a.renew(), true, 'still ours');
    await tick(30); //                    the run outlives its lease without renewing ...
    assert.equal(b.renew(), true); //     ... so another tab takes over
    assert.equal(a.renew(), false, 'and this tab is told to stop');
    return 'sent';
  }), 'sent');
});

test('if the browser refuses Web Locks, the lease is used instead', async () => {
  const refusing = { request: async () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); } };
  const storage = sharedStorage();
  const a = createPublishLock({ storage, locks: () => refusing, key: KEY, tab: 'a' });
  assert.equal(await a.run(async () => 'sent'), 'sent');
  storage.set(KEY, { owner: 'other', until: Date.now() + 60e3 });
  assert.equal(await a.run(async () => 'sent'), LOCKED);
});

test('an error from the work itself is passed on, and both locks are freed', async () => {
  const locks = lockManager();
  const storage = sharedStorage();
  const a = createPublishLock({ storage, locks: () => locks, key: KEY, tab: 'a' });
  let runs = 0;
  await assert.rejects(a.run(async () => { runs++; throw new Error('boom'); }), /boom/);
  assert.equal(runs, 1, 'not run a second time through the fallback');
  assert.equal(locks.held.size, 0);
  assert.equal(storage.m.has(KEY), false);
});
