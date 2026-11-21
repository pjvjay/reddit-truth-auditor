/** Where a link post points: host + article kind. Never the path. */
import { safeUrl } from '../core/util.js';

const SOCIAL_HOSTS = /(^|\.)(twitter\.com|x\.com|facebook\.com|fb\.watch|instagram\.com|tiktok\.com|threads\.net|truthsocial\.com|t\.me|bsky\.app)$/;
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|rumble\.com|vimeo\.com|bitchute\.com|odysee\.com|dailymotion\.com)$/;
const BLOG_HOSTS = /(^|\.)(substack\.com|medium\.com|wordpress\.com|blogspot\.com|ghost\.io|tumblr\.com)$/;
const REDDIT_HOSTS = /(^|\.)(reddit\.com|redd\.it|redditmedia\.com|redditstatic\.com|imgur\.com)$/;
const OPINION_PATH = /\/(opinions?|commentisfree|op-?eds?|columns?|columnists?|editorials?|voices|perspectives?|comment)(\/|$)/;
const ANALYSIS_PATH = /\/(analysis|explainers?|news-analysis)(\/|$)/;
const VIDEO_PATH = /\/(videos?|watch|tv|live)(\/|$)/;

/**
 * @returns {{domain: string, kind: 'news'|'opinion'|'analysis'|'video'|'social'|'blog'} | null}
 *   null for self posts and Reddit-hosted media.
 */
export function sourceOf(p) {
  const u = safeUrl(p && p.url);
  if (!u || !(p && p.url)) return null;
  const x = new URL(u);
  const host = x.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
  if (!/^[a-z0-9.-]{3,253}$/.test(host) || REDDIT_HOSTS.test(host)) return null;
  const path = x.pathname.toLowerCase();
  let kind = 'news';
  if (SOCIAL_HOSTS.test(host)) kind = 'social';
  else if (VIDEO_HOSTS.test(host)) kind = 'video';
  else if (BLOG_HOSTS.test(host)) kind = 'blog';
  else if (OPINION_PATH.test(path)) kind = 'opinion';
  else if (ANALYSIS_PATH.test(path)) kind = 'analysis';
  else if (VIDEO_PATH.test(path)) kind = 'video';
  return { domain: host, kind };
}
