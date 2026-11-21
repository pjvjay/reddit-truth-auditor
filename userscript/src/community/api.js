/**
 * HTTP client for the community API (see docs/community-api.md).
 * Every call records connectivity in the community status, so the UI can show
 * "offline - N reports queued" and the publisher knows when to retry.
 */
import { httpRequest } from '../core/env.js';
import { settings } from '../core/settings.js';
import { parseJsonLoose, apiErrorMessage } from '../core/util.js';
import { communityBase, setCommunityStatus } from './config.js';

export class ApiError extends Error {
  constructor(message, { status = 0, network = false, body = null } = {}) {
    super(message);
    this.status = status;
    this.network = network; // unreachable / timed out
    this.body = body;
  }
  /** Worth retrying later (offline, overloaded, rate limited). */
  get transient() { return this.network || this.status === 429 || this.status >= 500; }
  get auth() { return this.status === 401 || this.status === 403; }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && settings.communityToken) headers['X-RTA-Token'] = settings.communityToken;
  let res;
  try {
    res = await httpRequest({ method, url: `${communityBase()}${path}`, headers, data: body ? JSON.stringify(body) : null, timeout: 30000 });
  } catch (e) {
    setCommunityStatus({ online: false });
    throw new ApiError(e.message, { network: true });
  }
  if (res.status >= 500 || res.status === 0) setCommunityStatus({ online: false });
  else setCommunityStatus({ online: true, lastContact: Date.now() });
  if (res.status < 200 || res.status >= 300) {
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch (_) { /* not JSON */ }
    throw new ApiError(`HTTP ${res.status}: ${apiErrorMessage(res)}`, { status: res.status, body: parsed });
  }
  return parseJsonLoose(res.text);
}

export const api = {
  /** Propositions the community agrees are false (rta.feed/1). */
  feed: (minClients) => request('GET', `/v1/propositions/feed?min_clients=${minClients}`),
  /** Ranked event clusters of propagating false claims (rta.clusters/1). */
  clusters: (limit = 25) => request('GET', `/v1/clusters?limit=${limit}`),
  /** Publish a batch of anonymous reports (rta.report/1). Returns { accepted, rejected: [{index, code, reason}], keys, quota }. */
  publish: (batch) => request('POST', '/v1/reports', batch),
};
