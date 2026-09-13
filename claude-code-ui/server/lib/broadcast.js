/*
 * The connected browsers, and the ways to talk to them.
 *
 * `broadcast` is for things true of the whole app regardless of which
 * conversation a tab is looking at (auth, the sessions catalog, HA links).
 * `sendToSession` is for one run's own events — only connections currently
 * viewing that session hear about them, which is what lets two tabs run two
 * different conversations without either seeing the other's traffic.
 */
export const connections = new Set();

export function send(ws, data) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

export function broadcast(msg) {
  for (const ws of connections) send(ws, msg);
}

/** Every open connection currently viewing `sessionId` (never matches null —
 *  "not viewing any saved session yet" is not a shared room). */
export function viewersOf(sessionId) {
  const out = [];
  if (!sessionId) return out;
  for (const ws of connections) if (ws._state?.sessionId === sessionId) out.push(ws);
  return out;
}

export function sendToSession(sessionId, msg) {
  for (const ws of viewersOf(sessionId)) send(ws, msg);
}

/** Like sendToSession, but reaches every connected tab when nobody happens to
 *  be looking at this conversation right now — used only for things a human
 *  genuinely needs to see (a permission prompt, a question), matching the old
 *  single-session app's fallback for headless/backgrounded runs. */
export function sendToSessionOrBroadcast(sessionId, msg) {
  const viewers = viewersOf(sessionId);
  if (viewers.length) { for (const ws of viewers) send(ws, msg); }
  else broadcast(msg);
}
