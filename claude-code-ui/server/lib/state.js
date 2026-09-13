/*
 * The handful of values that genuinely span the whole process.
 *
 * There used to be one process-wide "active session" here. There is no longer
 * a single active session: each browser connection tracks its own view (see
 * `ws._state.sessionId` in ws-protocol.js), and each session that actually has
 * a query in flight gets its own entry in `runtime.runs` — a Map keyed by a
 * random `runId` rather than by session id, because a brand-new chat's run
 * starts before the SDK has assigned it a session id (that arrives on the
 * first 'init' event, see run-query.js). `findRunBySessionId` is the lookup
 * every other module uses instead of reading a global pointer.
 */
import { randomUUID } from 'crypto';
import { DEFAULT_PERMISSION_MODE } from './config.js';

export const runtime = {
  /** runId -> RunEntry, one per session currently mid-query. */
  runs: new Map(),

  /** Plugin/agent slash commands from the SDK init event, cached so a newly
   *  connected client can populate its autocomplete immediately. */
  cachedSlashCommands: [],

  /** Set when a query fails for an auth reason. The credentials file still
   *  exists in that case, so isAuthenticated() alone would keep hiding the login
   *  screen; this is what lets the UI show a re-auth prompt instead. */
  credentialsExpired: false,

  /** Link targets so replies can turn entity ids into Home Assistant links. */
  haLinks: { entities: [], automations: {} },
};

/**
 * One in-flight (or about-to-be) run. `sessionId` starts as the resume target
 * (an existing session) or null (a brand-new chat) and is corrected to the
 * SDK-assigned id as soon as the 'init' event names it. `originWs` is the
 * connection that started the run — the only one a permission prompt is ever
 * sent to directly, and whose disconnect auto-denies this run's open prompts
 * (see ws-protocol.js's close handler).
 */
export function createRun(sessionId) {
  const run = {
    runId: randomUUID(),
    sessionId: sessionId || null,
    originWs: null,
    abortController: null,
    permMode: DEFAULT_PERMISSION_MODE,
    pendingPermissions: new Map(),   // id -> { toolName, resolve }
    pendingDialogs: new Map(),       // id -> { payload, resolve }
  };
  runtime.runs.set(run.runId, run);
  return run;
}

export function removeRun(run) {
  runtime.runs.delete(run.runId);
}

/** The run currently resuming/updating this session, if any. A session can
 *  only ever have one live run at a time — two tabs prompting the same
 *  conversation at once is refused, not merged (see run-query.js) — but two
 *  *different* sessions each get their own independent entry here, which is
 *  what lets separate conversations run concurrently. */
export function findRunBySessionId(sessionId) {
  if (!sessionId) return undefined;
  for (const run of runtime.runs.values()) if (run.sessionId === sessionId) return run;
  return undefined;
}

/** Find whichever run owns this pending-permission or pending-dialog id. Ids
 *  are random UUIDs, unique across every concurrent run, so a flat scan needs
 *  no session context from the caller. */
export function findRunByPendingId(mapName, id) {
  for (const run of runtime.runs.values()) if (run[mapName].has(id)) return run;
  return undefined;
}
