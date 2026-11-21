/**
 * Tone: humour, sarcasm & satire.
 *
 * toneSignals() gives free local hints (satire sites/subreddits, "/s", flair);
 * the model makes the final call. Evident satire is discounted, satire passed
 * off as real news keeps its full risk, and sarcasm is decoded upstream so the
 * intended meaning is what gets audited.
 */
import { safeUrl, hostOf } from '../core/util.js';
import { settings } from '../core/settings.js';

const SATIRE_DOMAINS = ['theonion.com', 'babylonbee.com', 'clickhole.com', 'thebeaverton.com', 'newsthump.com', 'thedailymash.co.uk',
  'waterfordwhispersnews.com', 'thehardtimes.net', 'reductress.com', 'duffelblog.com', 'der-postillon.com', 'the-postillon.com',
  'theshovel.com.au', 'chaser.com.au', 'fakingnews.com', 'hard-drive.net', 'thespoof.com', 'newsbiscuit.com', 'thelapine.ca',
  'thedailybonnet.com', 'sportspickle.com', 'elmundotoday.com', 'legorafi.fr', 'lercio.it', 'worldnewsdailyreport.com', 'thepoke.co.uk'];
const SATIRE_SUBS = new Set(['theonion', 'satire', 'babylonbee', 'thebabylonbee', 'thebeaverton', 'clickhole', 'thehardtimes', 'reductress',
  'newsthump', 'thedailymash', 'subredditsimulator', 'subsimulatorgpt2', 'subsimgpt2interactive', 'totallynotrobots', 'shittyaskscience', 'shittylifeprotips']);
const HUMOUR_SUBS = new Set(['funny', 'memes', 'dankmemes', 'me_irl', 'meirl', '2meirl4meirl', 'shitposting', 'comedycemetery', 'comedyheaven',
  'wholesomememes', 'historymemes', 'prequelmemes', 'programmerhumor', 'sciencememes', 'politicalhumor', 'politicalcompassmemes',
  'bonehurtingjuice', 'terriblefacebookmemes', 'atetheonion', 'jokes', 'dadjokes', 'antimeme', 'surrealmemes']);
const REAL_ABSURD_SUBS = new Set(['nottheonion', 'floridaman', 'offbeat']);
const SARC_MARK = /(^|[\s([])\/(s|sarcasm|j|jk)\b(?!\/)|\[\s*sarcasm\s*\]/i;
const TITLE_LABEL = /[[(]\s*(satire|satirical|parody|joke|humou?r|shitpost|meme)\s*[\])]/i;
const HUMOUR_FLAIR = /satire|humou?r|meme|shitpost|joke|funny|parody|sarcas|circlejerk|comedy|\blol\b|fluff/i;

/**
 * Free, local tone signals. `frame` is the coarse framing used to keep duplicates apart:
 * literal | sarcasm | humour | satire-venue (satire sub) | satire-link (satire site posted elsewhere).
 */
export function toneSignals(p) {
  const sub = String(p.subreddit || '').toLowerCase();
  const text = `${p.title || ''}\n${String(p.body || '').slice(0, 3000)}`;
  const u = safeUrl(p.url);
  const host = u ? hostOf(u) : '';
  const satireSite = !!host && (SATIRE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) || (host === 'newyorker.com' && /\/humor\//.test(u)));
  const satireSub = SATIRE_SUBS.has(sub) || /circlejerk/.test(sub);
  const humourSub = !satireSub && (HUMOUR_SUBS.has(sub) || /memes?$|humou?r$|^shitpost|^okbuddy/.test(sub));
  const realAbsurd = REAL_ABSURD_SUBS.has(sub);
  const sarcMark = SARC_MARK.test(text);
  const labelled = TITLE_LABEL.test(p.title || '') || HUMOUR_FLAIR.test(p.flair || '');
  const hints = [];
  if (satireSub) hints.push(`r/${p.subreddit} is a satire/parody subreddit – posts there are not meant literally.`);
  if (humourSub) hints.push(`r/${p.subreddit} is a humour/meme subreddit.`);
  if (realAbsurd) hints.push(`r/${p.subreddit} only allows REAL news stories that sound like satire – do not dismiss it as satire.`);
  if (satireSite) {
    hints.push(`The linked site ${host} publishes satire.${
      satireSub || humourSub ? '' : ' It was posted in a non-satire subreddit – check whether it is being passed off as real news.'}`);
  }
  if (sarcMark) hints.push('The post contains a sarcasm/joke marker ("/s" or "/j") – the literal words probably mean the opposite.');
  if (labelled) hints.push(`The post is labelled as humour/satire (${HUMOUR_FLAIR.test(p.flair || '') ? `flair "${p.flair}"` : 'title label'}).`);
  let frame = 'literal';
  if (satireSub || (satireSite && humourSub)) frame = 'satire-venue';
  else if (satireSite) frame = 'satire-link';
  else if (sarcMark) frame = 'sarcasm';
  else if (humourSub || labelled) frame = 'humour';
  return { frame, hints, satireSite, satireSub, humourSub, realAbsurd, sarcMark, labelled, host };
}

export const TONES = ['sincere', 'sarcastic', 'humorous', 'satirical', 'unclear'];
export const NON_LITERAL = ['humorous', 'satirical'];

export function toneOf(r) {
  if (!r) return 'sincere';
  if (TONES.includes(r.tone)) return r.tone;
  return (r.sarcasm || 0) >= (Number(settings.satireCutoff) || 7) ? 'satirical' : 'sincere'; // pre-1.2 records
}
export const isNonLiteral = (r) => NON_LITERAL.includes(toneOf(r));
export const satireAsFact = (r) => isNonLiteral(r) && !!r.presentedAsFact;
export const harmlessJoke = (r) => isNonLiteral(r) && !r.presentedAsFact;

/**
 * Tone class for claim-level duplicate matching: l = literal (incl. decoded sarcasm),
 * n = joke/satire not meant as fact, f = joke/satire passed off as fact.
 */
export const toneClass = (tone, paf) => (NON_LITERAL.includes(tone) ? (paf ? 'f' : 'n') : 'l');

/** Evident satire/jokes keep this fraction of their literal risk (when "treat as harmless" is on). */
export const SATIRE_DISCOUNT = 0.2;
