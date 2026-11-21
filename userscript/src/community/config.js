/** Community configuration helpers and connection status (persisted, shared by all tabs). */
import { storage } from '../core/env.js';
import { settings, KEYS } from '../core/settings.js';
import { emit } from '../core/events.js';

/** Joined and a server URL is set. */
export const communityConfigured = () => !!(settings.communityEnabled && String(settings.communityUrl || '').trim());
export const communityBase = () => String(settings.communityUrl || '').trim().replace(/\/+$/, '');
export const minClients = () => Math.max(1, parseInt(settings.communityMinClients, 10) || 3);

/** Random 128-bit anonymous install id (resettable in Settings). */
export function clientId() {
  let id = storage.get(KEYS.clientId, '');
  if (!/^c_[0-9a-f]{32}$/.test(id)) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    id = `c_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    storage.set(KEYS.clientId, id);
  }
  return id;
}
export const resetClientId = () => { storage.set(KEYS.clientId, ''); return clientId(); };

const STATUS_DEFAULTS = {
  online: null, //        true / false / null (unknown) - result of the last request to the server
  lastContact: 0, //      last successful request
  lastSync: 0, //         last successful feed download
  syncError: null,
  sent: 0, //             reports accepted by the server (lifetime)
  lastSend: 0,
  sendError: null,
  authError: false, //    server rejected the publishing token - publishing paused until settings change
};

export function communityStatus() {
  const s = storage.get(KEYS.commStatus, null);
  return { ...STATUS_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
}

export function setCommunityStatus(patch) {
  storage.set(KEYS.commStatus, { ...communityStatus(), ...patch });
  emit('community:changed');
}
