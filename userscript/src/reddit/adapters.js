/**
 * Reddit page adapters: find posts in the page and read what we can from the DOM.
 * Supports the current "shreddit" UI, old.reddit.com and the legacy 2018 redesign.
 */
import { squash } from '../core/util.js';

export const normId = (v) => { const m = String(v || '').trim().match(/^(?:t3_)?([a-z0-9]{2,12})$/i); return m ? `t3_${m[1].toLowerCase()}` : null; };
const idFromPermalink = (p) => { const m = String(p || '').match(/\/comments\/([a-z0-9]+)/i); return m ? `t3_${m[1].toLowerCase()}` : null; };
const subFromPermalink = (p) => { const m = String(p || '').match(/\/r\/([^/]+)/i); return m ? m[1] : ''; };
const textOf = (el) => (el ? squash(el.textContent) : '');
const intAttr = (el, a) => { const n = parseInt(String(el.getAttribute(a) || '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

/** Zero-height slot after the post; the badge floats into the post's action row. */
function slotAfter(el, pill) {
  const slot = document.createElement('div');
  slot.className = 'rta-slot';
  slot.appendChild(pill);
  el.insertAdjacentElement('afterend', slot);
  return slot;
}

/**
 * @typedef {object} DomPost
 * @property {string|null} id   t3_ fullname
 * @property {string} title
 * @property {string} subreddit
 * @property {string} permalink
 * @property {string} body
 * @property {string} url       linked URL ('' for self posts)
 * @property {string} domain
 * @property {string} flair
 * @property {string} author
 * @property {boolean} promoted
 * @property {{score:number, comments:number}} [engagement]
 * @property {number|null} [createdUtc]
 */
export const ADAPTERS = [
  {
    name: 'shreddit',
    selector: 'shreddit-post',
    /** @returns {DomPost} */
    read(el) {
      const permalink = el.getAttribute('permalink') || '';
      const domain = el.getAttribute('domain') || '';
      const isSelf = el.getAttribute('post-type') === 'text' || /^self\./i.test(domain);
      return {
        id: normId(el.getAttribute('id')) || idFromPermalink(permalink),
        title: el.getAttribute('post-title') || textOf(el.querySelector('[slot="title"]')),
        subreddit: (el.getAttribute('subreddit-prefixed-name') || el.getAttribute('subreddit-name') || subFromPermalink(permalink)).replace(/^r\//i, ''),
        permalink,
        body: textOf(el.querySelector('[slot="text-body"]') || el.querySelector('[id$="-post-rtjson-content"]')),
        url: isSelf ? '' : el.getAttribute('content-href') || '',
        domain,
        flair: textOf(el.querySelector('shreddit-post-flair')),
        author: el.getAttribute('author') || '',
        promoted: el.hasAttribute('promoted') || el.getAttribute('is-promoted') === 'true',
        engagement: { score: intAttr(el, 'score'), comments: intAttr(el, 'comment-count') },
        createdUtc: Date.parse(el.getAttribute('created-timestamp') || '') / 1000 || null,
      };
    },
    mountPill: slotAfter,
  },
  {
    name: 'old',
    selector: '.thing.link[data-fullname]',
    read(el) {
      const permalink = el.getAttribute('data-permalink') || '';
      const domain = el.getAttribute('data-domain') || '';
      return {
        id: normId(el.getAttribute('data-fullname')),
        title: textOf(el.querySelector('a.title')),
        subreddit: el.getAttribute('data-subreddit') || subFromPermalink(permalink),
        permalink,
        body: textOf(el.querySelector('.expando .usertext-body .md')),
        url: /^self\./i.test(domain) ? '' : el.getAttribute('data-url') || '',
        domain,
        flair: textOf(el.querySelector('.linkflairlabel')),
        author: el.getAttribute('data-author') || '',
        promoted: el.classList.contains('promoted') || el.getAttribute('data-promoted') === 'true',
        engagement: { score: intAttr(el, 'data-score'), comments: intAttr(el, 'data-comments-count') },
        createdUtc: (parseInt(el.getAttribute('data-timestamp'), 10) / 1000) || null,
      };
    },
    /** Inline in the "comments share save …" row - no layout shift. */
    mountPill(el, pill) {
      const ul = el.querySelector('.entry ul.flat-list.buttons');
      if (!ul) return slotAfter(el, pill);
      pill.classList.add('rta-inline');
      const li = document.createElement('li');
      li.className = 'rta-li';
      li.appendChild(pill);
      ul.appendChild(li);
      return li;
    },
  },
  {
    name: 'legacy',
    selector: 'div[data-testid="post-container"]',
    read(el) {
      const a = el.querySelector('a[data-click-id="body"], a[href*="/comments/"]');
      const permalink = a ? new URL(a.getAttribute('href'), location.href).pathname : '';
      return {
        id: (/^t3_/.test(el.id) && normId(el.id)) || idFromPermalink(permalink),
        title: textOf(el.querySelector('h1, h3')),
        subreddit: subFromPermalink(permalink),
        permalink,
        body: textOf(el.querySelector('[data-click-id="text"]')),
        url: '',
        domain: '',
        flair: '',
        author: '',
        promoted: !!el.querySelector('[data-testid="promoted-post"]'),
      };
    },
    mountPill: slotAfter,
  },
];

export const adapterFor = (el) => ADAPTERS.find((a) => el.matches(a.selector)) || ADAPTERS[0];
