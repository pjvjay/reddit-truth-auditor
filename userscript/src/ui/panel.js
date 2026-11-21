/**
 * The side panel: launcher tab, header, tabs, list/settings views, banners and
 * footer. Lives in a Shadow DOM so Reddit's CSS cannot leak in or out. Reacts to
 * core events; other UI modules navigate by emitting ui:* events.
 */
import { addPageStyle, browserOnline } from '../core/env.js';
import { settings, saveSettings } from '../core/settings.js';
import { on } from '../core/events.js';
import { log } from '../core/logger.js';
import { plural, throttle } from '../core/util.js';
import { isFlagged } from '../analysis/risk.js';
import { researchLog } from '../store/research-log.js';
import { getUsage, budgetLeft } from '../store/usage.js';
import { communityConfigured, communityStatus } from '../community/config.js';
import { queuedCount } from '../community/publisher.js';
import { jobs, runtime, clearHalt, clearSession, queueStats } from '../pipeline/jobs.js';
import { rearm } from '../pipeline/scanner.js';
import { h, icon, setChildren } from './dom.js';
import { ui } from './context.js';
import { renderCard, removeCard, markOnScreen, pulseCard, focusCard } from './cards.js';
import { renderPill, removePill } from './pills.js';
import { renderHistory } from './history.js';
import { renderTrends } from './trends.js';
import { showSettings, updateCommunityStatus } from './settings-view.js';
import { downloadCsv } from './export.js';
import PANEL_CSS from './styles/panel.css';
import PAGE_CSS from './styles/page.css';

let dismissedTavily = false;

function attachStyles(shadow) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PANEL_CSS);
    shadow.adoptedStyleSheets = [sheet];
    if (shadow.adoptedStyleSheets.length === 1) return;
  } catch (_) { /* constructable stylesheets unsupported - fall back */ }
  shadow.appendChild(h('style', {}, PANEL_CSS));
}

// ---------------------------------------------------------------- open / close / tabs
export function open(reason) {
  if (ui.isOpen) return;
  ui.isOpen = true;
  let i = 0;
  for (const card of ui.list.children) card.style.setProperty('--i', i < 12 ? i++ : 12); // staggered entrance
  ui.panel.classList.add('open');
  ui.panel.setAttribute('aria-hidden', 'false');
  ui.launcher.classList.add('hidden');
  if (ui.tab === 'history') renderHistory();
  log('panel open:', reason);
}

export function close() {
  if (!ui.isOpen) return;
  ui.isOpen = false;
  ui.panel.classList.remove('open');
  ui.panel.setAttribute('aria-hidden', 'true');
  ui.launcher.classList.remove('hidden');
  setTimeout(() => { if (!ui.isOpen) ui.views.classList.remove('settings'); }, 650);
}

export const toggle = () => (ui.isOpen ? close() : open('toggle'));

function nudgeLauncher() {
  ui.launcher.classList.remove('nudge');
  void ui.launcher.offsetWidth;
  ui.launcher.classList.add('nudge');
}

export function setTab(tab) {
  ui.tab = tab;
  ui.tabs.setAttribute('data-tab', tab);
  ui.listScroll.setAttribute('data-tab', tab);
  for (const [cls, name] of [['live', 'live'], ['flag', 'flagged'], ['hist', 'history'], ['trend', 'trends']]) {
    ui.tabs.querySelector(`.tab.${cls}`).classList.toggle('active', tab === name);
  }
  if (tab === 'history') renderHistory(true);
  else if (tab === 'trends') renderTrends(false);
  else ui.list.setAttribute('data-filter', tab);
  ui.views.classList.remove('settings');
  updateEmpty();
}

function togglePause() {
  saveSettings({ paused: !settings.paused });
  updatePauseButton();
  if (!settings.paused) rearm();
  updateStatus();
  showBanners();
}

function updatePauseButton() {
  const b = ui.counters.pause;
  b.replaceChildren(icon(settings.paused ? 'play' : 'pause', 17));
  b.title = settings.paused ? 'Resume scanning' : 'Pause scanning';
  b.setAttribute('aria-label', b.title);
}

// ---------------------------------------------------------------- status, footer, banners
export function updateStatus() {
  if (!ui.panel) return;
  const c = ui.counters;
  const all = [...jobs.values()];
  const { active, queued } = queueStats();
  const flagged = all.filter(isFlagged).length;
  const checked = all.filter((j) => j.state === 'done' || j.state === 'skipped').length;
  let text;
  if (!settings.apiKey) text = 'Setup needed';
  else if (runtime.halted) text = 'Stopped – see message below';
  else if (settings.paused) text = 'Paused';
  else if (active || queued) text = `Checking ${active}${queued ? ` · ${queued} queued` : ''}`;
  else text = `Watching · ${checked} checked`;
  c.status.textContent = text;
  c.liveDot.className = `live-dot${settings.paused || runtime.halted || !settings.apiKey ? ' paused' : ' on'}`;
  c.live.textContent = String(ui.list.children.length);
  c.flagged.textContent = String(flagged);
  c.flagged.classList.toggle('hot', flagged > 0);
  c.history.textContent = String(researchLog.size());
  c.launcherCount.textContent = String(flagged);
  c.launcherCount.classList.toggle('show', flagged > 0);
  ui.launcher.classList.toggle('busy', active > 0);
  ui.launcher.classList.toggle('needs-setup', !settings.apiKey);
  updateEmpty();
}

export function updateFooter() {
  if (!ui.usage) return;
  const u = getUsage();
  const cap = Number(settings.dailyBudgetUsd) || 0;
  const community = communityConfigured();
  const st = communityStatus();
  const queued = queuedCount();
  setChildren(ui.usage,
    h('div', {}, 'Today ', h('b', {}, `$${u.usd.toFixed(4)}`), cap > 0 ? ` of $${cap.toFixed(2)} cap` : ' (no cap)'),
    h('div', {}, `${u.checks || 0} checked · ${u.reused || 0} reused from log · ${community ? `${u.community || 0} from community · ` : ''}${u.searches || 0} search${u.searches === 1 ? '' : 'es'}`),
    community ? h('div', { class: `conn ${st.online === false || !browserOnline() ? 'off' : ''}` },
      h('span', { class: 'dot' }), st.online === false || !browserOnline() ? 'Community offline' : 'Community connected',
      queued ? ` · ${plural(queued, 'report')} queued` : '') : null);
}

function updateEmpty() {
  if (!ui.list) return;
  const count = ui.tab === 'flagged' ? [...ui.list.children].filter((c) => c.classList.contains('flagged')).length : ui.list.children.length;
  let content = null;
  if (!count) {
    if (ui.tab === 'flagged') {
      content = [h('div', { class: 'e-icon' }, icon('check', 24)), h('div', {}, 'Nothing risky spotted yet.'), h('div', {}, `Posts with risk ≥ ${settings.riskThreshold}% will appear here.`)];
    } else if (settings.apiKey) {
      content = [h('div', { class: 'e-icon' }, icon('eye', 24)), h('div', {}, 'Scroll through Reddit as usual.'), h('div', {}, 'Posts you stop on are fact-checked automatically and show up here.')];
    }
  }
  ui.empty.classList.toggle('show', !!content);
  if (content) setChildren(ui.empty, content);
}

const banner = (kind, iconName, ...body) => h('div', { class: `banner ${kind}` }, icon(iconName, 16), h('div', { class: 'b-body' }, ...body));
const actionRow = (...buttons) => h('div', {}, ...buttons);
const smallBtn = (label, onclick, primary = false) => h('button', { class: `btn small${primary ? ' primary' : ''}`, type: 'button', onclick }, label);

export function showBanners() {
  if (!ui.banners) return;
  const b = [];
  if (!settings.apiKey) {
    b.push(banner('info', 'shield', h('b', {}, 'Welcome! '), 'Add an OpenAI API key to start fact-checking the posts you view. It is stored only in your userscript manager.',
      actionRow(smallBtn('Open settings', () => showSettings(), true))));
  }
  if (runtime.halted) {
    b.push(banner('bad', 'alert', h('b', {}, 'Checks stopped. '), runtime.halted,
      actionRow(smallBtn('Fix in settings', () => showSettings()), ' ', smallBtn('Try again', () => { clearHalt(); rearm(); }))));
  }
  if (budgetLeft() <= 0) {
    b.push(banner('warn', 'alert', h('b', {}, 'Daily spending cap reached. '), `New posts won't be checked until tomorrow (cap: $${Number(settings.dailyBudgetUsd).toFixed(2)}).`,
      actionRow(smallBtn('Raise cap', () => showSettings()))));
  }
  if (settings.paused && settings.apiKey) b.push(banner('warn', 'pause', 'Scanning is paused. Cached results are still shown.'));
  const queued = queuedCount();
  if (communityConfigured() && settings.shareReports && queued && (communityStatus().online === false || !browserOnline())) {
    b.push(banner('info', 'globe', h('b', {}, 'Community server unreachable. '),
      `Fact-checking continues locally – ${plural(queued, 'report')} saved and will be published automatically when it is back.`));
  }
  if (settings.apiKey && !settings.tavilyKey && !dismissedTavily) {
    b.push(banner('info', 'search', 'Running without live web research – verdicts on recent news are less reliable. Add a Tavily key in settings for source-backed checks.',
      actionRow(smallBtn('Dismiss', () => { dismissedTavily = true; showBanners(); }))));
  }
  setChildren(ui.banners, b);
  updateStatus();
}

// ---------------------------------------------------------------- build
export function initPanel() {
  ui.host = h('div', { id: 'reddit-truth-auditor' });
  ui.shadow = ui.host.attachShadow({ mode: 'open' });
  attachStyles(ui.shadow);
  addPageStyle(PAGE_CSS);
  try { CSS.registerProperty({ name: '--rta-p', syntax: '<number>', inherits: false, initialValue: '0' }); } catch (_) { /* already registered / unsupported */ }

  const c = ui.counters;
  c.launcherCount = h('span', { class: 'count' }, '0');
  ui.launcher = h('button', { class: 'launcher', type: 'button', title: 'Reddit Truth Auditor (Alt+Shift+R)', 'aria-label': 'Open Reddit Truth Auditor', onclick: toggle },
    h('span', { class: 'ring' }), h('span', { class: 'l-icon' }, icon('shield', 16)), c.launcherCount, h('span', { class: 'setup' }));

  c.liveDot = h('span', { class: 'live-dot' });
  c.status = h('span', {}, 'Idle');
  c.pause = h('button', { class: 'btn-icon', type: 'button', onclick: togglePause });
  c.live = h('span', { class: 'n' }, '0');
  c.flagged = h('span', { class: 'n' }, '0');
  c.history = h('span', { class: 'n' }, '0');
  const tab = (cls, name, label, counter, title) => h('button', { class: `tab ${cls}`, type: 'button', role: 'tab', title, onclick: () => setTab(name) }, label, counter);
  ui.tabs = h('div', { class: 'tabs four', 'data-tab': 'live', role: 'tablist', style: { '--n': 4 } },
    h('span', { class: 'tab-ind' }),
    tab('live active', 'live', 'Live', c.live),
    tab('flag', 'flagged', 'Flagged', c.flagged),
    tab('hist', 'history', 'History', c.history, 'Everything researched so far (local log)'),
    tab('trend', 'trends', 'Trends', null, 'False narratives that are spreading – community-wide or from your own history'));
  const head = h('div', { class: 'head' },
    h('div', { class: 'head-row' },
      h('div', { class: 'brand' }, icon('shield', 18)),
      h('div', { class: 'titles' }, h('div', { class: 'title' }, 'Truth Auditor'), h('div', { class: 'status' }, c.liveDot, c.status)),
      c.pause,
      h('button', { class: 'btn-icon', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => showSettings() }, icon('sliders', 17)),
      h('button', { class: 'btn-icon', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close panel', onclick: close }, icon('x', 18))),
    ui.tabs);

  ui.banners = h('div', { class: 'banners' });
  ui.empty = h('div', { class: 'empty' });
  ui.list = h('div', { class: 'list', 'data-filter': 'live' });
  ui.history = h('div', { class: 'history' });
  ui.trends = h('div', { class: 'trends' });
  ui.usage = h('div', { class: 'usage' });
  ui.listScroll = h('div', { class: 'scroll', 'data-tab': 'live' }, ui.banners, ui.list, ui.empty, ui.history, ui.trends);
  const listView = h('div', { class: 'view' }, ui.listScroll,
    h('div', { class: 'foot' }, ui.usage,
      h('button', { class: 'btn-icon', type: 'button', title: 'Export the research log as CSV', 'aria-label': 'Export CSV', onclick: downloadCsv }, icon('download', 16)),
      h('button', { class: 'btn-icon', type: 'button', title: 'Clear the live list (the research log is kept)', 'aria-label': 'Clear list', onclick: () => { clearSession(); updateStatus(); } }, icon('trash', 16))));
  ui.settingsView = h('div', { class: 'view' });
  ui.views = h('div', { class: 'views' }, listView, ui.settingsView);
  ui.panel = h('aside', { class: 'panel', role: 'complementary', 'aria-label': 'Reddit Truth Auditor', 'aria-hidden': 'true' }, head, ui.views);
  ui.shadow.append(h('div', { class: 'rta' }, ui.launcher, ui.panel));
  (document.body || document.documentElement).appendChild(ui.host);

  ui.panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.code === 'KeyR' || e.key === 'R' || e.key === 'r')) { e.preventDefault(); toggle(); }
  }, true);

  wireEvents();
  updatePauseButton();
  updateStatus();
  updateFooter();
  showBanners();
}

function wireEvents() {
  const renderHistorySoon = throttle(() => { if (ui.isOpen && ui.tab === 'history') renderHistory(); }, 800);
  on('job:update', (job) => { renderCard(job); renderPill(job); updateStatus(); });
  on('job:removed', (id) => { removeCard(id); removePill(id); updateStatus(); });
  on('job:visible', (id, visible) => markOnScreen(id, visible));
  on('job:alert', (job) => {
    if (settings.autoOpen !== 'never') open('flag');
    else nudgeLauncher();
    pulseCard(job.id);
  });
  on('status:changed', updateStatus);
  on('usage:changed', updateFooter);
  on('log:changed', () => { ui.counters.history.textContent = String(researchLog.size()); renderHistorySoon(); });
  on('community:changed', () => { updateFooter(); updateCommunityStatus(); showBanners(); });
  on('settings:changed', () => { updatePauseButton(); showBanners(); updateFooter(); for (const job of jobs.values()) renderPill(job); });
  on('ui:open', (reason) => open(reason));
  on('ui:tab', (tab) => setTab(tab));
  on('ui:focus', (id) => { ui.views.classList.remove('settings'); focusCard(id); });
  on('ui:settings', () => showSettings());
  on('ui:banners', showBanners);
  on('ui:history', () => renderHistory());
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { updateFooter(); showBanners(); });
    window.addEventListener('offline', () => { updateFooter(); showBanners(); });
  }
}
