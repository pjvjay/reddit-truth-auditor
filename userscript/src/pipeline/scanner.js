/**
 * Finds posts on the page, tracks which are on screen, and reports a "dwell"
 * once a post has stayed visible for `settings.dwellMs` (so fast scrolling
 * costs nothing).
 */
import { settings } from '../core/settings.js';
import { emit } from '../core/events.js';
import { throttle } from '../core/util.js';
import { ADAPTERS } from '../reddit/adapters.js';

const seen = new WeakSet();
const adapterOf = new WeakMap();
const idOf = new WeakMap();
const timers = new Map();
/** Post elements currently on screen. */
export const visible = new Set();
let io = null;
let onDwell = () => {};

export const adapterForElement = (el) => adapterOf.get(el);

function arm(el) {
  if (timers.has(el)) return;
  timers.set(el, setTimeout(() => {
    timers.delete(el);
    if (visible.has(el) && el.isConnected && document.visibilityState === 'visible') onDwell(el, adapterOf.get(el));
  }, Math.max(0, Number(settings.dwellMs) || 0)));
}

function hide(el) {
  visible.delete(el);
  clearTimeout(timers.get(el));
  timers.delete(el);
  const id = idOf.get(el);
  if (id) emit('job:visible', id, false);
}

function onIntersect(entries) {
  const vh = window.innerHeight || 800;
  for (const e of entries) {
    const el = e.target;
    const show = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= vh * 0.35);
    if (!show) { hide(el); continue; }
    if (!visible.has(el)) {
      visible.add(el);
      const id = idOf.get(el);
      if (id) emit('job:visible', id, true);
    }
    arm(el);
  }
}

function scan() {
  for (const adapter of ADAPTERS) {
    for (const el of document.querySelectorAll(adapter.selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      adapterOf.set(el, adapter);
      const id = adapter.read(el).id;
      if (id) {
        idOf.set(el, id);
        emit('post:element', id, el); // Reddit's SPA may re-render a post we already know
      }
      io.observe(el);
    }
  }
  for (const el of [...visible]) if (!el.isConnected) hide(el);
}

/** Re-run dwell for everything on screen (after the key is added, scanning resumes, …). */
export function rearm() { for (const el of visible) arm(el); }

/** @param {(el: Element, adapter: object) => void} dwellHandler */
export function startScanner(dwellHandler) {
  onDwell = dwellHandler;
  io = new IntersectionObserver(onIntersect, { threshold: Array.from({ length: 11 }, (_, i) => i / 10) });
  scan();
  new MutationObserver(throttle(scan, 400)).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rearm(); });
}
