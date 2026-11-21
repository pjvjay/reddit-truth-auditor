/** OpenAI-compatible chat completions (JSON mode) and Tavily web search. */
import { httpRequest } from '../core/env.js';
import { settings, DEFAULTS } from '../core/settings.js';
import { sleep, str, squash, safeUrl, parseJsonLoose, apiErrorMessage } from '../core/util.js';
import { addUsage } from '../store/usage.js';

/**
 * Ask the model for a JSON object. Tracks token cost (added to today's usage and to `meter`).
 * Retries rate limits / 5xx; drops `temperature` / JSON mode for models that reject them.
 * Throws an Error with `.fatal = true` for bad keys / exhausted quota.
 */
export async function llmJson(messages, cfg = settings, meter = null) {
  const base = String(cfg.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  const body = { model: cfg.model || DEFAULTS.model, temperature: 0, response_format: { type: 'json_object' }, messages };
  for (let attempt = 0; ; attempt++) {
    const res = await httpRequest({
      method: 'POST',
      url: `${base}/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      data: JSON.stringify(body),
      timeout: 90000,
    });
    if (res.status >= 200 && res.status < 300) {
      let j;
      try { j = JSON.parse(res.text); } catch (_) { throw new Error('The LLM endpoint returned a non-JSON response'); }
      const u = j.usage || {};
      const cost = ((u.prompt_tokens || 0) * (Number(cfg.priceInPerM) || 0) + (u.completion_tokens || 0) * (Number(cfg.priceOutPerM) || 0)) / 1e6;
      addUsage({ usd: cost, llmCalls: 1 });
      if (meter) meter.usd += cost;
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return parseJsonLoose(content);
    }
    const msg = apiErrorMessage(res);
    if (res.status === 400 && /temperature/i.test(msg) && 'temperature' in body) { delete body.temperature; continue; }
    if (res.status === 400 && /response_format|json_object/i.test(msg) && body.response_format) { delete body.response_format; continue; }
    const quota = /quota|billing/i.test(msg);
    if (((res.status === 429 && !quota) || res.status >= 500) && attempt < 2) {
      await sleep(1500 * (attempt + 1) ** 2);
      continue;
    }
    const err = new Error(`LLM error ${res.status}: ${msg}`);
    err.fatal = res.status === 401 || res.status === 403 || quota;
    throw err;
  }
}

/** Tavily search: { answer, results: [{ title, url, content }] }. */
export async function tavilySearch(query) {
  const key = settings.tavilyKey;
  const res = await httpRequest({
    method: 'POST',
    url: 'https://api.tavily.com/search',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    data: JSON.stringify({ api_key: key, query: String(query).slice(0, 380), search_depth: 'basic', max_results: 5, include_answer: true }),
    timeout: 45000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Tavily ${res.status}: ${apiErrorMessage(res)}`);
  const j = parseJsonLoose(res.text);
  addUsage({ searches: 1 });
  return {
    answer: str(j.answer).slice(0, 800),
    results: (Array.isArray(j.results) ? j.results : []).slice(0, 6).map((r) => ({
      title: str(r.title).slice(0, 200),
      url: str(r.url),
      content: squash(str(r.content)).slice(0, 700),
    })).filter((r) => safeUrl(r.url)),
  };
}
