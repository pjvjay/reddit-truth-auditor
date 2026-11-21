/**
 * Outlet registry lookups (JS side). Data: spec/outlets.json - shared with the
 * community server, so both sides group outlets by the same ownership groups.
 */
import REGISTRY from '../../../spec/outlets.json' with { type: 'json' };

const OUTLETS = REGISTRY.outlets;
const MULTI = new Set(REGISTRY.multi_part_suffixes);
const ALIASES = { ...REGISTRY.aliases };
for (const [dom, o] of Object.entries(OUTLETS)) if (!(o.name.toLowerCase() in ALIASES)) ALIASES[o.name.toLowerCase()] = dom;

const stripPrefix = (h) => String(h || '').toLowerCase().trim().replace(/\.$/, '').replace(/^(www|m|amp|mobile)\./, '');

/** eTLD+1 for the common cases (edition.cnn.com -> cnn.com, www.bbc.co.uk -> bbc.co.uk). */
export function registrable(host) {
  const parts = stripPrefix(host).split('.');
  if (parts.length >= 3 && MULTI.has(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** { domain, outlet, group, tier, type } - longest listed suffix wins; unknown sites are tier 3. */
export function lookupDomain(host) {
  const h = stripPrefix(host);
  if (!/^[a-z0-9.-]{3,253}$/.test(h) || !h.includes('.')) return null;
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    const o = OUTLETS[cand];
    if (o) return { domain: cand, outlet: o.name, group: o.group, tier: o.tier, type: o.type };
  }
  const reg = registrable(h);
  return { domain: reg, outlet: reg, group: reg, tier: 3, type: 'unknown' };
}

/** Outlet a post attributes a claim to ("according to Fox News"). */
export function lookupName(name) {
  let n = String(name || '').toLowerCase().replace(/[^a-z0-9 .&'-]/g, '').trim();
  if (!(n in ALIASES)) n = n.replace(/^the /, '');
  const dom = ALIASES[n] || ALIASES[`the ${n}`];
  return dom ? lookupDomain(dom) : null;
}

/** How much one independent source counts towards diversity. */
export function sourceWeight(info, kind) {
  if (!info) return 0;
  if (['social', 'video', 'blog'].includes(info.type) || ['social', 'video', 'blog'].includes(kind)) return REGISTRY.platform_weight;
  return REGISTRY.tier_weight[String(info.tier)] || 0.4;
}
