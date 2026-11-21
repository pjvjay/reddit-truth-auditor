/** Settings view (slides in over the list). */
import { storage, scriptVersion } from '../core/env.js';
import { settings, DEFAULTS, KEYS, saveSettings } from '../core/settings.js';
import { emit } from '../core/events.js';
import { clampNum, ago, plural, utcDay } from '../core/util.js';
import { llmJson } from '../analysis/llm.js';
import { researchLog } from '../store/research-log.js';
import { knowledge } from '../community/knowledge.js';
import { communityConfigured, communityStatus, resetClientId } from '../community/config.js';
import { flush, queuedCount, discardQueued, quotaNotice } from '../community/publisher.js';
import { h, icon, setChildren } from './dom.js';
import { ui } from './context.js';

let form = {};
let commStatusEl = null;

const field = (label, control, hint) => h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
const keyHint = (v) => (v ? `Saved (ends in …${v.slice(-4)}). Leave blank to keep it.` : '');
const input = (key, attrs) => (form[key] = h('input', { class: 'inp', ...attrs }));
const secretInput = (key, placeholder) => input(key, { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: settings[key] ? '•••••••• saved' : placeholder });
function checkbox(key, label) {
  form[key] = h('input', { type: 'checkbox' });
  form[key].checked = !!settings[key];
  return h('label', { class: 'check' }, form[key], h('span', {}, label));
}
/** Range slider with a live value + description. */
function slider(key, { min, max, step, cls, aria, describe }) {
  form[key] = h('input', { type: 'range', class: cls, min, max, step, value: settings[key], 'aria-label': aria });
  const val = h('div', { class: 'range-val' }), desc = h('div', { class: 'range-desc' });
  const sync = () => { const v = Number(form[key].value); val.textContent = `${v}%`; desc.textContent = describe(v); };
  form[key].addEventListener('input', sync);
  sync();
  return h('div', { class: 'range-wrap' }, h('div', { class: 'range-top' }, val, desc), form[key]);
}
/** Button that asks for confirmation on the first click. */
function confirmButton(label, confirmLabel, done, action) {
  return h('button', { class: 'btn small danger', type: 'button', onclick: (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.lastChild.textContent = confirmLabel(); return; }
    action();
    b.lastChild.textContent = done;
  } }, icon('trash', 13), h('span', {}, label));
}

function modelTest() {
  const out = h('div', { class: 'test-out' });
  const button = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    const cfg = { ...settings, apiKey: form.apiKey.value.trim() || settings.apiKey, model: form.model.value.trim() || DEFAULTS.model, baseUrl: form.baseUrl.value.trim() || DEFAULTS.baseUrl };
    if (!cfg.apiKey) { out.className = 'test-out bad'; out.textContent = 'Enter an API key first.'; return; }
    out.className = 'test-out';
    out.textContent = 'Testing…';
    try {
      const j = await llmJson([{ role: 'user', content: 'Reply with the JSON object {"ok": true}.' }], cfg);
      out.className = `test-out ${j && j.ok ? 'ok' : 'bad'}`;
      out.textContent = j && j.ok ? `Connected – ${cfg.model} is working.` : 'Connected, but the reply was unexpected.';
    } catch (e) { out.className = 'test-out bad'; out.textContent = e.message; }
  } }, 'Test');
  return { button, out };
}

const EXAMPLE_REPORT = () => ({
  schema: 'rta.report/1', client: 'c_…random…',
  reports: [{
    claim: { subject: 'World Health Organization', predicate: 'states', object: '5G towers spread the coronavirus', polarity: 'affirms', quantities: [], time: null, place: null, topic: 'health' },
    key: 'p1_…', claim_truth: 1, confidence: 'high', tone: 'sincere', presented_as_fact: false, researched: true, sources: ['https://…'],
    verdict: '…', model: 'gpt-4o-mini', post: '<hash>', subreddit: 'worldnews', url_hash: null, day: utcDay(), origin: 'audit',
    source: { domain: 'edition.cnn.com', kind: 'news' }, attributed: null, engagement: { score: 1200, comments: 340, crossposts: 2 }, post_day: utcDay(),
  }],
});

function sharedInfo() {
  const pre = h('pre', { class: 'payload' });
  const d = h('details', {}, h('summary', {}, 'What exactly is shared?'),
    h('div', { class: 'd-body' },
      h('div', { class: 'hint' }, 'Only for claims judged false (or already on the community list). Never the post text, title, author, your Reddit account, the link path or exact times:'),
      h('ul', { class: 'share-list' },
        h('li', {}, 'the canonical claim (subject / predicate / object / numbers / place / topic) and its proposition key'),
        h('li', {}, 'the verdict: truth score, confidence, tone, sources, model'),
        h('li', {}, 'one-way hashes of the post id and the linked URL (lets the server count distinct posts)'),
        h('li', {}, 'public post metadata: the linked site (host only) and article kind, an outlet the post cites, upvotes / comments / crossposts'),
        h('li', {}, 'the subreddit name (optional), the day the post was created and the day you saw it (UTC)'),
        h('li', {}, 'a random anonymous install id (resettable below)')),
      h('div', { class: 'hint' }, 'Last batch sent (or an example):'), pre));
  d.addEventListener('toggle', () => { pre.textContent = JSON.stringify(storage.get(KEYS.lastPayload, null) || EXAMPLE_REPORT(), null, 2); });
  return d;
}

/** Community connection / publishing status box. */
export function updateCommunityStatus() {
  const el = commStatusEl;
  if (!el || !el.isConnected) return;
  const st = communityStatus();
  const queued = queuedCount();
  const limit = quotaNotice();
  if (!communityConfigured()) {
    setChildren(el, h('div', {}, 'Not connected. Tick “Join” and enter a server URL, then Save.'),
      queued ? h('div', {}, `${plural(queued, 'report')} from your research log will be shared once you connect.`) : null);
    return;
  }
  const conn = st.online === false ? 'offline – reports are kept locally' : st.online ? 'connected' : 'not contacted yet';
  setChildren(el,
    h('div', {}, h('span', { class: `dot ${st.online === false ? 'off' : st.online ? 'on' : ''}` }), h('b', {}, ` Server ${conn}`),
      st.lastContact ? ` · last contact ${ago(st.lastContact)}` : ''),
    h('div', {}, h('b', {}, `${knowledge.items.length.toLocaleString()} known mistruths`), ` · list synced ${knowledge.syncedAt ? ago(knowledge.syncedAt) : 'never'}`),
    h('div', {}, h('b', {}, `${plural(queued, 'report')} queued`), ` · ${st.sent || 0} shared`, st.lastSend ? ` · last sent ${ago(st.lastSend)}` : ''),
    st.authError ? h('div', { class: 'err' }, 'The server rejected the publishing token. Reports are kept and sent once it is fixed.') : null,
    st.syncError ? h('div', { class: 'err' }, `Sync: ${st.syncError}`) : null,
    st.sendError && !st.authError ? h('div', { class: 'err' }, `Publishing: ${st.sendError}`) : null,
    limit ? h('div', { class: 'quota' }, limit) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => knowledge.sync(true) }, icon('refresh', 13), 'Sync list now'),
      h('button', { class: 'btn small', type: 'button', onclick: () => flush({ force: true }) }, icon('globe', 13), 'Publish now'),
      queued ? h('button', { class: 'btn small danger', type: 'button', title: 'Forget the queued reports (your research log is kept)', onclick: () => discardQueued() }, 'Discard queue') : null));
}

function buildForm() {
  form = {};
  const s = settings;
  secretInput('apiKey', 'sk-…');
  secretInput('tavilyKey', 'tvly-… (optional)');
  secretInput('communityToken', 'only if the server requires one');
  input('model', { type: 'text', value: s.model, spellcheck: 'false' });
  input('baseUrl', { type: 'text', value: s.baseUrl, spellcheck: 'false' });
  input('dwellMs', { type: 'number', min: 0, max: 15000, step: 100, value: s.dwellMs });
  input('maxConcurrent', { type: 'number', min: 1, max: 4, step: 1, value: s.maxConcurrent });
  input('dailyBudgetUsd', { type: 'number', min: 0, step: 0.05, value: s.dailyBudgetUsd });
  input('logDays', { type: 'number', min: 1, max: 365, step: 1, value: s.logDays });
  input('maxLogEntries', { type: 'number', min: 100, max: 50000, step: 100, value: s.maxLogEntries });
  input('subsAllow', { type: 'text', value: s.subsAllow, placeholder: 'e.g. canada, worldnews (blank = all)' });
  input('subsBlock', { type: 'text', value: s.subsBlock, placeholder: 'e.g. memes, aww' });
  input('communityUrl', { type: 'url', value: s.communityUrl, spellcheck: 'false', placeholder: 'https://your-community-server.example' });
  input('communityMinClients', { type: 'number', min: 1, max: 100, step: 1, value: s.communityMinClients });
  input('priceInPerM', { type: 'number', min: 0, step: 0.01, value: s.priceInPerM });
  input('priceOutPerM', { type: 'number', min: 0, step: 0.01, value: s.priceOutPerM });
  form.referenceFacts = h('textarea', { class: 'inp', placeholder: 'Optional facts the auditor should treat as ground truth, e.g.\n- 2026 PR admissions target: 380,000' });
  form.referenceFacts.value = s.referenceFacts;
  form.autoOpen = h('select', { class: 'inp' },
    h('option', { value: 'risky' }, 'When a risky post is on screen (recommended)'),
    h('option', { value: 'always' }, 'Whenever posts are being researched'),
    h('option', { value: 'never' }, 'Never – just badge the launcher'));
  form.autoOpen.value = s.autoOpen;
  const risk = slider('riskThreshold', {
    min: 5, max: 100, step: 5, aria: 'Risk threshold',
    describe: (v) => `${v <= 30 ? 'Very sensitive' : v <= 55 ? 'Sensitive' : v <= 75 ? 'Balanced' : 'Only clear falsehoods'} – alerts when truth score ≤ ${Math.round(100 - v) / 10}/10`,
  });
  const dup = slider('dupThreshold', {
    min: 50, max: 100, step: 5, cls: 'neutral', aria: 'Duplicate similarity',
    describe: (v) => (v >= 100 ? 'Identical wording only' : v >= 85 ? 'Strict – minor edits only' : v >= 70 ? 'Balanced' : 'Loose – may reuse related posts'),
  });
  const test = modelTest();
  commStatusEl = h('div', { class: 'comm-status' });

  return h('div', { class: 'form' },
    h('div', { class: 'sec' }, 'Language model'),
    field('OpenAI API key', h('div', { class: 'row' }, form.apiKey, test.button), keyHint(s.apiKey) || 'Stored only in your userscript manager. Requests go straight from your browser to the API.'),
    test.out,
    h('div', { class: 'grid2' }, field('Model', form.model), field('API base URL', form.baseUrl)),
    h('div', { class: 'hint', style: { marginTop: '-6px', marginBottom: '10px' } }, 'Any OpenAI-compatible endpoint works (OpenRouter, local Ollama at http://localhost:11434/v1, …).'),

    h('div', { class: 'sec' }, 'Web research'),
    field('Tavily API key', form.tavilyKey, keyHint(s.tavilyKey) || 'Optional but recommended: one live web search per claim. Free tier at tavily.com.'),

    h('div', { class: 'sec' }, 'Alerts'),
    field('Risk threshold', risk, 'Risk = 100 − truth score × 10. The panel slides open for posts at or above this level.'),
    field('Open the panel automatically', form.autoOpen),
    checkbox('ignoreSatire', 'Treat evident satire & jokes as harmless – unless they are passed off as real news'),
    checkbox('skipSatireVenues', 'Don’t spend tokens on posts in satire subreddits (r/TheOnion, r/BabylonBee, *circlejerk…)'),
    h('div', { class: 'hint', style: { margin: '-4px 0 12px' } }, 'Sarcasm is always decoded – the author’s intended meaning is what gets fact-checked. Satire shared as if it were real news is always flagged.'),
    checkbox('inlineBadges', 'Show a status badge on each checked post'),

    h('div', { class: 'sec' }, 'Scanning & cost'),
    h('div', { class: 'grid2' },
      field('Check after on-screen for (ms)', form.dwellMs),
      field('Parallel checks', form.maxConcurrent),
      field('Daily spend cap (USD)', form.dailyBudgetUsd, '0 = no cap')),

    h('div', { class: 'sec' }, 'Research log & duplicates'),
    checkbox('dedupe', 'Reuse earlier verdicts for reposts & near-duplicates (crossposts, same link, near-identical text, same claim)'),
    field('Duplicate similarity', dup, 'Word-overlap needed to treat two posts (or two claims) as the same. Numbers and negations must always match.'),
    h('div', { class: 'grid2' }, field('Keep research log (days)', form.logDays), field('Max posts in log', form.maxLogEntries)),

    h('div', { class: 'sec' }, 'Subreddits'),
    field('Only check these', form.subsAllow),
    field('Never check these', form.subsBlock),

    h('div', { class: 'sec' }, 'Community network (optional)'),
    checkbox('communityEnabled', 'Join the community mistruth network'),
    h('div', { class: 'hint', style: { margin: '-4px 0 12px' } }, 'Publish anonymous reports of mistruths you encounter and use the list of mistruths other users agree on – matched on your device, so the server never sees what you browse. '
      + 'Works offline: everything is analysed and stored locally, and reports are published automatically whenever the server is reachable. Needs a community server (anyone can host one – see the project README).'),
    field('Community server URL', form.communityUrl),
    field('Publishing token', form.communityToken, keyHint(s.communityToken) || 'Optional – only if the server requires one.'),
    checkbox('shareReports', 'Share anonymous reports of mistruths I encounter'),
    checkbox('shareBacklog', 'Also share analyses made while offline or before I joined'),
    checkbox('shareSubreddit', 'Include the subreddit name in reports'),
    checkbox('useCommunity', 'Use community verdicts for known mistruths (skips web research & audit)'),
    field('Independent reporters required', form.communityMinClients, 'A community verdict is only used once at least this many different users agree.'),
    commStatusEl,
    sharedInfo(),
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn small', type: 'button', title: 'Start a new anonymous id – future reports cannot be linked to past ones',
        onclick: (e) => { resetClientId(); e.currentTarget.textContent = 'New anonymous id created'; } }, 'Reset anonymous id')),

    h('div', { class: 'sec' }, 'Reference facts'),
    field('Ground-truth notes for the auditor', form.referenceFacts, 'Injected into every audit prompt – useful for fast-moving topics.'),

    h('details', {}, h('summary', {}, 'Advanced'),
      h('div', { class: 'd-body' },
        h('div', { class: 'grid2' }, field('$ / 1M input tokens', form.priceInPerM), field('$ / 1M output tokens', form.priceOutPerM)),
        checkbox('debug', 'Log debug info to the browser console'),
        h('div', { class: 'row' },
          confirmButton('Clear research log', () => `Really delete ${researchLog.size()} entries?`, 'Research log cleared', () => researchLog.clear()),
          s.apiKey ? h('button', { class: 'btn small danger', type: 'button', onclick: (e) => { saveSettings({ apiKey: '' }); e.currentTarget.textContent = 'Key removed'; emit('ui:banners'); } }, 'Remove OpenAI key') : null,
          s.tavilyKey ? h('button', { class: 'btn small danger', type: 'button', onclick: (e) => { saveSettings({ tavilyKey: '' }); e.currentTarget.textContent = 'Key removed'; emit('ui:banners'); } }, 'Remove Tavily key') : null),
        h('div', { class: 'hint' }, `Version ${scriptVersion()}`))));
}

function collect() {
  const f = form;
  const num = (k, lo, hi) => clampNum(f[k].value, lo, hi, DEFAULTS[k]);
  const patch = {
    model: f.model.value.trim() || DEFAULTS.model,
    baseUrl: f.baseUrl.value.trim() || DEFAULTS.baseUrl,
    riskThreshold: num('riskThreshold', 0, 100),
    autoOpen: f.autoOpen.value,
    ignoreSatire: f.ignoreSatire.checked,
    skipSatireVenues: f.skipSatireVenues.checked,
    inlineBadges: f.inlineBadges.checked,
    dwellMs: num('dwellMs', 0, 15000),
    maxConcurrent: Math.round(num('maxConcurrent', 1, 4)),
    dailyBudgetUsd: num('dailyBudgetUsd', 0, 1000),
    logDays: num('logDays', 1, 365),
    maxLogEntries: Math.round(num('maxLogEntries', 100, 50000)),
    dedupe: f.dedupe.checked,
    dupThreshold: num('dupThreshold', 50, 100),
    subsAllow: f.subsAllow.value.trim(),
    subsBlock: f.subsBlock.value.trim(),
    referenceFacts: f.referenceFacts.value.trim(),
    communityEnabled: f.communityEnabled.checked,
    communityUrl: f.communityUrl.value.trim(),
    shareReports: f.shareReports.checked,
    shareBacklog: f.shareBacklog.checked,
    shareSubreddit: f.shareSubreddit.checked,
    useCommunity: f.useCommunity.checked,
    communityMinClients: Math.round(num('communityMinClients', 1, 100)),
    priceInPerM: num('priceInPerM', 0, 1000),
    priceOutPerM: num('priceOutPerM', 0, 1000),
    debug: f.debug.checked,
  };
  for (const k of ['apiKey', 'tavilyKey', 'communityToken']) { const v = f[k].value.trim(); if (v) patch[k] = v; }
  if (patch.communityEnabled && !settings.communityJoinedAt) patch.communityJoinedAt = Date.now();
  return patch;
}

function render() {
  const actions = h('div', { class: 'form-actions' }, h('span', { class: 'saved-msg' }, 'Saved ✓'),
    h('button', { class: 'btn', type: 'button', onclick: () => ui.views.classList.remove('settings') }, icon('back', 14), 'Back'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => {
      const before = { url: settings.communityUrl, min: settings.communityMinClients };
      saveSettings(collect()); // listeners re-evaluate flags, resume the queue, retry publishing…
      researchLog.prune();
      if (communityConfigured()) knowledge.sync(before.url !== settings.communityUrl || before.min !== settings.communityMinClients || !knowledge.syncedAt);
      render(); // refresh "saved key" hints and clear the secret fields
      const msg = ui.settingsView.querySelector('.saved-msg');
      msg.classList.add('show');
      setTimeout(() => { msg.classList.remove('show'); ui.views.classList.remove('settings'); }, 700);
    } }, 'Save'));
  setChildren(ui.settingsView, h('div', { class: 'scroll' }, buildForm()), actions);
  updateCommunityStatus();
}

export function showSettings() {
  emit('ui:open', 'settings');
  render();
  ui.views.classList.add('settings');
}
