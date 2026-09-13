/*
 * The WebSocket protocol: what a connecting browser is told, and what it may
 * ask for.
 *
 * Each connection tracks its own `sessionId` (`ws._state.sessionId`) — which
 * conversation this tab is currently looking at — rather than everyone
 * sharing one global pointer. That is what lets two tabs run two different
 * conversations at once: `session_switch`/`new_session` only ever change the
 * connection that sent them, and a run's own events go only to whichever
 * connections are currently viewing its session (broadcast.js's
 * `sendToSession`), not to everyone.
 *
 * The inbound half is a dispatch table rather than a chain of `else if`s, so the
 * set of messages the client may send is a list you can read.
 */
import { existsSync } from 'fs';
import { DEFAULT_PERMISSION_MODE } from './config.js';
import { log } from './log.js';
import { runtime, findRunBySessionId } from './state.js';
import { connections, send, broadcast } from './broadcast.js';
import {
  isAuthenticated, isSubscriptionAuth, startLoginFlow, loginUrl, loginProcess,
} from './auth.js';
import {
  listSessions, parseSession, deleteSession, sessionFile,
  getLastUsedSessionId, setLastUsedSessionId,
} from './sessions.js';
import { answerDialog } from './dialogs.js';
import { getNabuCasaUrl } from './nabu-casa.js';
import { resolvePermission, resolvePromptsAllowedBy } from './permissions.js';
import { saveAttachments, describeAttachments } from './uploads.js';
import { runQuery, abortActive } from './run-query.js';
import * as autoContinue from './auto-continue.js';

/** The auto-continue banner state relevant to one session, if any. */
function sendAutoContinueState(ws, sessionId) {
  const pending = autoContinue.autoContinue.pending?.sessionId === sessionId ? autoContinue.autoContinue.pending : null;
  const offer = autoContinue.liveLimitOffer(sessionId);
  if (pending) {
    send(ws, { type: 'auto_continue_pending', resetsAt: pending.resetsAt,
      rateLimitType: pending.rateLimitType, attempts: pending.attempts });
  } else if (offer) {
    send(ws, { type: 'limit_offer', resetsAt: offer.resetsAt,
      rateLimitType: offer.rateLimitType, supported: isSubscriptionAuth() });
  } else {
    send(ws, { type: 'limit_offer_cleared' });
  }
}

/** The session catalog, tagged with *this connection's own* idea of which one
 *  is active — never broadcast, since that would not be true for anyone else. */
function sendSessions(ws, state) {
  send(ws, { type: 'sessions', sessions: listSessions(), activeId: state.sessionId });
}

/** Replay whatever this connection's currently-viewed session needs: its
 *  transcript, whether it is running, and any question still waiting on it. */
function sendSessionView(ws, state) {
  const run = findRunBySessionId(state.sessionId);
  send(ws, { type: 'history', items: parseSession(state.sessionId), running: !!run });
  sendAutoContinueState(ws, state.sessionId);
  if (run) {
    for (const [id, d] of run.pendingDialogs) {
      send(ws, { type: 'user_dialog', id, dialogKind: 'askUserQuestion', payload: d.payload });
    }
  }
}

/** Everything a newly connected (or reconnected) tab needs to render the app. */
function greet(ws, state) {
  send(ws, { type: 'connected' });
  send(ws, {
    type: 'config',
    defaultPermMode: DEFAULT_PERMISSION_MODE,
    autoContinue: autoContinue.autoContinue.enabled,
    autoContinueSupported: isSubscriptionAuth(),
    selfSlug: runtime.selfSlug,
  });
  send(ws, { type: 'auth_status', authenticated: isAuthenticated() && !runtime.credentialsExpired });
  if (runtime.credentialsExpired) send(ws, { type: 'auth_expired', subscription: isSubscriptionAuth() });
  // A login is mid-flight (reconnected while waiting to paste the code) — restore
  // the URL and code box, so switching to the browser and back does not lose it.
  const url = loginUrl();
  if (url) send(ws, { type: 'auth_url', url });
  send(ws, { type: 'slash_commands', commands: runtime.cachedSlashCommands });
  send(ws, { type: 'ha_links', entities: runtime.haLinks.entities, automations: runtime.haLinks.automations });
  sendSessions(ws, state);
  sendSessionView(ws, state);
}

/** The catalog changed (a title updated, a session appeared/vanished) — every
 *  tab needs the new list, but not tagged with anyone else's activeId. */
function broadcastSessions() {
  broadcast({ type: 'sessions', sessions: listSessions() });
}

/** Everything the browser may send. One entry per message type. */
const handlers = {
  auth_check(ws) {
    send(ws, { type: 'auth_status', authenticated: isAuthenticated() });
  },

  auth_login() {
    startLoginFlow(broadcast, () => { runtime.credentialsExpired = false; });
  },

  auth_code(_ws, msg) {
    const proc = loginProcess();
    if (proc && proc.stdin) proc.stdin.write(msg.code + '\n');
  },

  // Asked lazily by voice.js, only once it has something to point at (the
  // browser has already ruled out HTTPS as the cause) — not sent to every
  // tab on connect, since most never need it. getNabuCasaUrl() never rejects
  // (falls back to null on any error), so nothing to catch here.
  nabu_casa_url(ws) {
    getNabuCasaUrl().then((url) => send(ws, { type: 'nabu_casa_url', url }));
  },

  prompt(ws, msg, state) {
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      msg.text = describeAttachments(msg.text, saveAttachments(msg.attachments));
    }
    delete msg.attachments;   // do not carry the base64 payload any further
    runQuery(ws, state, { ...msg, sessionId: state.sessionId });
  },

  abort(_ws, _msg, state) {
    if (state.sessionId) { abortActive(state.sessionId); return; }
    if (state.pendingRunId) runtime.runs.get(state.pendingRunId)?.abortController?.abort();
  },

  new_session(ws, _msg, state) {
    state.sessionId = null;
    // Also updates the shared default, matching the original behavior: a
    // fresh tab that has never expressed a preference lands on "new chat"
    // right after someone starts one, rather than an old conversation.
    setLastUsedSessionId(null);
    send(ws, { type: 'cleared' });
  },

  sessions_list(ws, _msg, state) {
    sendSessions(ws, state);
  },

  session_switch(ws, msg, state) {
    // No existence check: a session's transcript file may not be flushed to
    // disk the instant it starts (another tab could be switching to a
    // conversation it just this moment created), and parseSession() already
    // degrades gracefully to an empty transcript for an id that never existed
    // or was deleted mid-flight — no error needed either way.
    const id = msg.id || null;
    state.sessionId = id;
    // This tab explicitly chose a conversation — that becomes the new default
    // for the *next* fresh, unqualified connection too (persisted on disk),
    // but it does not move any other already-open tab, which is the whole
    // point: two tabs can now look at two different conversations at once.
    setLastUsedSessionId(id);
    sendSessions(ws, state);
    sendSessionView(ws, state);
  },

  session_delete(_ws, msg) {
    if (findRunBySessionId(msg.id)) abortActive(msg.id);
    deleteSession(msg.id);
    if (getLastUsedSessionId() === msg.id) setLastUsedSessionId(null);
    // Any tab currently looking at the session that just vanished needs to be
    // told directly — it is the one thing this handler cannot leave to the
    // sessions-catalog broadcast below, since that only lists what exists now.
    for (const ws of connections) {
      if (ws._state?.sessionId === msg.id) {
        ws._state.sessionId = null;
        send(ws, { type: 'cleared' });
        sendSessions(ws, ws._state);
      }
    }
    broadcastSessions();
  },

  permission_response(_ws, msg) {
    resolvePermission(msg.id, msg.decision);
  },

  user_dialog_response(_ws, msg) {
    // An answer to an AskUserQuestion. `result` absent means Skip — Claude is
    // told nobody answered and carries on. (Closing the card to read the chat
    // first sends nothing at all: the question stays pending, and the strip above
    // the composer is the way back to it.)
    answerDialog(msg.id, msg.result);
  },

  set_perm_mode(_ws, msg, state) {
    // Takes effect immediately for ask/acceptEdits/bypass, which route through
    // canUseTool — but only for the run belonging to *this tab's own* viewed
    // session; a run in a different, unrelated conversation is unaffected.
    const run = findRunBySessionId(state.sessionId) || (state.pendingRunId && runtime.runs.get(state.pendingRunId));
    if (!run) return;   // no live run here yet — the next prompt just uses the new mode directly
    run.permMode = msg.mode;
    resolvePromptsAllowedBy(run, msg.mode);
  },

  set_auto_continue(_ws, msg) {
    autoContinue.setEnabled(msg.enabled);
  },

  cancel_auto_continue(_ws, _msg, state) {
    autoContinue.cancelIfSession(state.sessionId, 'user');
  },
};

export function attach(wss) {
  wss.on('connection', (ws, req) => {
    connections.add(ws);

    // A reconnecting/returning tab names the session it was last looking at
    // (persisted client-side in sessionStorage — see connection.js) so it comes
    // straight back to that conversation instead of landing on "new chat".
    // A tab with no preference of its own yet (first-ever visit, or storage
    // was cleared) falls back to whichever session was used most recently by
    // anyone — the single-conversation app's old default, still right for the
    // common case of one person with several tabs open on the same machine.
    let initialSessionId = null;
    try {
      const requested = new URL(req.url, 'http://internal').searchParams.get('sessionId');
      if (requested && existsSync(sessionFile(requested))) initialSessionId = requested;
    } catch (e) { log('WARN', `could not parse connection URL for a sessionId: ${e.message}`); }
    if (!initialSessionId) initialSessionId = getLastUsedSessionId();

    const state = { sessionId: initialSessionId, pendingRunId: null };
    ws._state = state;   // exposed so set_perm_mode/close can find this tab's own run

    greet(ws, state);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const handler = handlers[msg.type];
      if (!handler) return;
      try {
        handler(ws, msg, state);
      } catch (e) {
        log('ERROR', `handling ${msg.type} failed: ${e?.message || e}`);
      }
    });

    ws.on('close', () => {
      connections.delete(ws);
      // The active query is deliberately NOT aborted: it keeps running and
      // persisting, so the chat is complete when the user navigates back. Only
      // this tab's own run's pending permission prompts are cleared (it is the
      // only connection they were ever sent to — see permissions.js), so the run
      // does not hang waiting on a browser that has gone.
      for (const run of runtime.runs.values()) {
        if (run.originWs !== ws) continue;
        for (const entry of run.pendingPermissions.values()) entry.resolve('deny');
        run.pendingPermissions.clear();
      }
      // Questions are NOT cleared here. They are not tied to a connection — a
      // phone backgrounding its browser drops the socket routinely, and that used
      // to auto-answer the question "closed without answering" behind the user's
      // back. The run itself owns the wait (via the tool call's abort signal), so
      // Stop, a new prompt, or a session switch already end it correctly.
    });
  });
}
