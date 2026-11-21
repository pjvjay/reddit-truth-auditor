/**
 * Result records stored in the research log.
 *
 *   kind 'audit' - fact-checked: truth, risk, tone, verdict, sources, canon…
 *   kind 'skip'  - nothing to check (no claim), or evident satire (toneSkip)
 *
 * Reused results carry `dupOf` (local duplicate) or `community` (shared list);
 * `report` holds the public post metadata needed to publish it later.
 */
import { settings } from '../core/settings.js';
import { clampNum, str, asBool, hostOf, truncate } from '../core/util.js';
import { TONES, NON_LITERAL } from '../text/tone.js';
import { cleanCanonical } from '../text/canonical.js';

/** The post fields kept with a result (for display, History and CSV - never published). */
export const slimPost = (p) => ({
  title: p.title, subreddit: p.subreddit, permalink: p.permalink, domain: p.domain || '', url: p.url || '', flair: p.flair || '',
});

/** Normalise the audit model's JSON into a result. */
export function normaliseAudit(a, ext, research, post, sig) {
  const truth = Math.round(clampNum(a.truth_score, 0, 10, 5) * 10) / 10;
  const sarcasm = Math.round(clampNum(a.satire_score != null ? a.satire_score : a.sarcasm_score, 0, 10, 0) * 10) / 10;
  const conf = str(a.confidence).toLowerCase();
  const at = str(a.tone).toLowerCase(), et = str(ext.tone).toLowerCase();
  const tone = TONES.includes(at) ? at : TONES.includes(et) ? et : sarcasm >= (Number(settings.satireCutoff) || 7) ? 'satirical' : 'sincere';
  const paf = NON_LITERAL.includes(tone) && (a.presented_as_fact != null ? asBool(a.presented_as_fact) : asBool(ext.presented_as_fact));
  return {
    kind: 'audit',
    truth,
    sarcasm,
    risk: Math.round((10 - truth) * 10),
    tone,
    presentedAsFact: paf,
    toneReason: str(a.tone_reason),
    toneHints: sig ? sig.hints : [],
    literalClaim: tone === 'sarcastic' ? str(ext.literal_claim) : '',
    confidence: ['low', 'medium', 'high'].includes(conf) ? conf : 'medium',
    claim: str(ext.claim),
    summary: str(ext.summary),
    contentType: str(ext.content_type),
    query: str(ext.query),
    factualCheck: str(a.factual_check),
    contextCheck: str(a.context_check),
    verdict: str(a.verdict),
    researched: !!(research && research.results && research.results.length),
    researchError: (research && research.error) || null,
    sources: research && research.results ? research.results.map((r) => ({ title: r.title, url: r.url })) : [],
    model: settings.model,
    at: Date.now(),
    post: slimPost(post),
  };
}

/** Satire/jokes not fact-checked because they are evidently not meant as fact. */
export function toneSkipResult(post, tone, reason, summary, hints) {
  return {
    kind: 'skip', toneSkip: true, tone, reason, contentType: tone === 'humorous' ? 'joke/meme' : 'satire',
    summary: summary || '', toneHints: hints || [], at: Date.now(), post: slimPost(post),
  };
}

/** Nothing checkable in the post. */
export function noClaimResult(post, ext) {
  return { kind: 'skip', contentType: str(ext.content_type), summary: str(ext.summary), tone: ext.tone, at: Date.now(), post: slimPost(post) };
}

/**
 * A copy of an earlier verdict, attributed to the post it came from. When the new post
 * takes the opposite stance on the same proposition (e.g. debunks a known lie), the
 * truth score is inverted instead of copied.
 */
export function reuseResult(origId, orig, post, via, sim, newCanon) {
  const root = orig.dupOf || { id: origId, title: orig.post && orig.post.title, sub: orig.post && orig.post.subreddit, permalink: orig.post && orig.post.permalink, at: orig.at };
  const extra = {};
  if (newCanon && orig.canon && newCanon.stance !== orig.canon.stance && orig.kind === 'audit') {
    const truth = Math.round((10 - orig.truth) * 10) / 10;
    const what = orig.truth <= 4 ? 'Rejects a claim already judged false' : orig.truth >= 6 ? 'Disputes a claim already judged true' : 'Takes the opposite side of an unverified claim';
    Object.assign(extra, {
      truth,
      risk: Math.round((10 - truth) * 10),
      canon: newCanon,
      verdict: `${what}: “${truncate(orig.canon.sentence || orig.claim || '', 160)}”.`,
      contextCheck: `Earlier verdict on the opposite claim: ${orig.verdict}`,
    });
  } else if (newCanon) extra.canon = newCanon;
  const { report: _ignored, ...rest } = orig; // the original post's metadata must not travel with the copy
  return {
    ...rest,
    ...extra,
    post: slimPost(post),
    dupOf: { id: root.id, title: root.title, sub: root.sub, permalink: root.permalink, at: root.at, via, sim: sim == null ? null : Math.round(sim * 100) },
  };
}

/**
 * A verdict taken from the community consensus (no research / audit tokens spent).
 * @param {{item: object, via: 'key'|'fuzzy'|'link', sim: number}} m  a match from the community knowledge base
 */
export function communityResult(m, post, ext, canon, sig) {
  const it = m.item, c = it.consensus, n = it.counts || {};
  const stance = canon ? canon.stance : 'affirms';
  const truth = Math.round((stance === 'affirms' ? c.prop_truth : 10 - c.prop_truth) * 10) / 10;
  const tone = ext ? ext.tone : (sig && sig.frame === 'satire-link' ? 'satirical' : 'sincere');
  const plural = (k) => `${k} post${k === 1 ? '' : 's'}`;
  return {
    kind: 'audit',
    truth,
    sarcasm: 0,
    risk: Math.round((10 - truth) * 10),
    tone,
    presentedAsFact: NON_LITERAL.includes(tone) && (ext ? !!ext.presented_as_fact : true),
    toneReason: '',
    toneHints: sig ? sig.hints : [],
    literalClaim: ext && tone === 'sarcastic' ? str(ext.literal_claim) : '',
    confidence: c.confidence,
    claim: ext ? ext.claim : it.sentence,
    summary: ext ? str(ext.summary) : '',
    contentType: ext ? str(ext.content_type) : '',
    query: '',
    factualCheck: `Community consensus: ${c.n_clients} independent users judged “${it.sentence}” false (average ${c.prop_truth}/10, ${Math.round(c.agreement * 100)}% agreement).`,
    contextCheck: `Seen in ${plural(n.posts || 0)} (${n.spreading || 0} spreading it, ${n.debunking || 0} debunking it).`,
    verdict: stance === 'affirms' ? (c.verdict || `Known mistruth: ${it.sentence}.`) : `Debunks a known mistruth: “${it.sentence}”.`,
    researched: false,
    researchError: null,
    sources: c.sources.map((u) => ({ title: hostOf(u), url: u })),
    model: 'community',
    at: Date.now(),
    post: slimPost(post),
    canon: canon || (it.claim ? { fields: cleanCanonical(it.claim), key: it.key, stance: 'affirms', tokens: it.tokens, sentence: it.sentence } : null),
    community: {
      key: it.key, via: m.via, sim: m.sim == null ? null : Math.round(m.sim * 100),
      nClients: c.n_clients, posts: n.posts || 0, spreading: n.spreading || 0, debunking: n.debunking || 0, propTruth: c.prop_truth,
    },
  };
}
