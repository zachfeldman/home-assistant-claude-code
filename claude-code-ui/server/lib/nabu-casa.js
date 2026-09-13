/*
 * Nabu Casa's remote-access URL, so a "voice input needs HTTPS" error can
 * point at a one-click fix when the user already has one set up, instead of
 * just describing what to go set up.
 *
 * Home Assistant's Cloud status (`remote_domain`, whether the remote UI is
 * actually connected) only exists over Core's own WebSocket API — there is no
 * REST equivalent — so this opens a short-lived connection through the same
 * Supervisor WS proxy (and the same auth handshake) scripts/lib/ha-ws.cjs
 * uses for the ha-tools CLI, just scoped to the one command this needs rather
 * than pulling that whole (CommonJS, CLI-oriented) module into the server.
 */
import WebSocket from 'ws';
import { SUPERVISOR_URL } from './config.js';
import { vlog } from './log.js';

const WS_URL = `${SUPERVISOR_URL.replace(/^http/, 'ws')}/core/api/websocket`;

// The answer only changes by the user's own action (setting up or tearing down
// Nabu Casa remote access) — cheap enough to cache rather than open a fresh
// socket for every request, including several in quick succession from one
// person repeatedly holding Space before the first answer has come back.
const CACHE_MS = 5 * 60 * 1000;
let cached = null;   // { url: string|null, at: number }
let inFlight = null; // a Promise, so concurrent callers share one request

export function getNabuCasaUrl() {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.url);
  if (inFlight) return inFlight;

  inFlight = fetchNabuCasaUrl().then((url) => {
    cached = { url, at: Date.now() };
    inFlight = null;
    vlog(`nabu casa remote url: ${url || '(not connected)'}`);
    return url;
  });
  return inFlight;
}

function fetchNabuCasaUrl() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(WS_URL);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      try { ws.close(); } catch {}
    };
    const timer = setTimeout(() => finish(null), 5000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (msg.type === 'auth_invalid') {
        finish(null);
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: 1, type: 'cloud/status' }));
      } else if (msg.type === 'result' && msg.id === 1) {
        const r = (msg.success && msg.result) || {};
        finish(r.remote_connected && r.remote_domain ? `https://${r.remote_domain}` : null);
      }
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(null));
  });
}
