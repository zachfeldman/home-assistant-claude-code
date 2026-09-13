/*
 * One turn: build the SDK options, run the query, and map its events onto the
 * wire protocol the browser speaks.
 *
 * Each run gets its own record (state.js's `createRun`) instead of reusing one
 * process-wide pointer, so two *different* conversations can be in flight at
 * once. The same conversation cannot run twice at once — the SDK cannot
 * resume one session from two overlapping `query()` calls — which is why a
 * prompt against a session that already has a run in flight is refused here
 * rather than queued or left to clobber the first one.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  WORK_DIR, PLUGINS, EFFORT_LEVELS, DEFAULT_PERMISSION_MODE,
} from './config.js';
import { log, vlog } from './log.js';
import { runtime, createRun, removeRun, findRunBySessionId } from './state.js';
import { send, broadcast, sendToSession, viewersOf } from './broadcast.js';
import { isAuthError, isSubscriptionAuth } from './auth.js';
import { listSessions, isQuestionAnswer, truncateOutput, setLastUsedSessionId } from './sessions.js';
import { hooksFor, makeCanUseTool } from './permissions.js';
import { askQuestion } from './dialogs.js';
import { refreshHaLinks } from './ha-links.js';
import { usableSlashCommands } from './slash-commands.js';
import * as autoContinue from './auto-continue.js';

/** How long the SDK may go quiet before the log says so. */
const STALL_WARN_MS = 20000;
const STALL_CHECK_MS = 15000;

/** Abort whichever run is resuming this session, if any. */
export function abortActive(sessionId) {
  const run = findRunBySessionId(sessionId);
  if (run?.abortController) run.abortController.abort();
  return !!run;
}

/**
 * `connState` is a connection's own `ws._state` for an interactive prompt, or
 * a throwaway `{ pendingRunId: null }` for a headless one (auto-continue, a
 * diag route) — it only needs to track this tab's not-yet-assigned new-chat
 * run, since everything else lives on the run record itself. `sessionId` is
 * the resume target: the tab's current session for an interactive prompt, or
 * an explicit id passed in for a headless resume that has no "current tab".
 * Returns the run's final session id (useful to headless callers).
 */
export async function runQuery(ws, connState, { text, permissionMode, model, effort, autoAttempts = 0, sessionId }) {
  const resuming = !!sessionId;

  if (resuming && findRunBySessionId(sessionId)) {
    send(ws, { type: 'error', message: 'This conversation already has a response in progress.' });
    return sessionId;
  }
  // A brand-new chat resubmitted rapidly from the same tab supersedes its own
  // not-yet-assigned previous attempt — the one case where cancel-and-replace
  // is still right, because both attempts belong to the same tab and neither
  // has a session id yet for anyone else to be looking at.
  if (!resuming && connState.pendingRunId) {
    runtime.runs.get(connState.pendingRunId)?.abortController?.abort();
  }

  // A run that is not itself the auto-continue firing supersedes any scheduled
  // resume *for this same session* — the user has taken over. A prompt in an
  // unrelated session must not cancel some other conversation's pending resume.
  if (autoAttempts === 0) {
    autoContinue.cancelIfSession(sessionId, 'superseded-by-prompt');
    autoContinue.clearLimitOfferIfSession(sessionId, 'superseded-by-prompt');
  }

  const run = createRun(sessionId);
  run.originWs = ws;
  const abortController = new AbortController();
  run.abortController = abortController;
  if (!resuming) connState.pendingRunId = run.runId;
  const startedAt = Date.now();

  /** Route this run's own events: to every tab currently viewing its session
   *  once it has one, or straight back to the tab that started it before
   *  then (a session that does not exist yet cannot have any other viewers). */
  const emit = (msg) => { if (run.sessionId) sendToSession(run.sessionId, msg); else send(ws, msg); };

  // Set if a 5-hour usage-limit rejection stops this run. Trusted over anything
  // that follows it — see the note by the 'result' handler.
  let limitHit = null;
  // tool_use id → tool name for this run: a tool_result carries only the id, and
  // an answered question has to be told apart from a real failure.
  const liveToolNames = new Map();

  // Show the user's message on other tabs already viewing this conversation
  // (the sender rendered it locally, and the SDK persists it to the session
  // store, so nothing is recorded here). Only meaningful once there is a real
  // session id — a brand-new chat cannot have any other viewers yet, and
  // `viewersOf(null)` would otherwise match every *other* tab that also
  // happens to be on "new chat", leaking prompts between unrelated ones.
  if (sessionId) for (const c of viewersOf(sessionId)) if (c !== ws) send(c, { type: 'user', text });

  const opts = { cwd: WORK_DIR, abortController, plugins: PLUGINS };
  if (model) opts.model = model;
  // Only override effort when the UI asked for a level; otherwise the SDK's own
  // model default applies.
  if (effort && EFFORT_LEVELS.has(effort)) opts.effort = effort;

  run.permMode = permissionMode || DEFAULT_PERMISSION_MODE;

  const hooks = hooksFor(run.permMode, run);
  if (hooks) opts.hooks = hooks;

  if (run.permMode === 'auto') {
    // A model classifier approves or denies each tool — no prompts, no canUseTool.
    opts.permissionMode = 'auto';
  } else {
    // 'plan' is SDK-native (read-only, produces a plan) but still routes through
    // canUseTool so the ExitPlanMode approval surfaces as a normal prompt.
    if (run.permMode === 'plan') opts.permissionMode = 'plan';
    opts.canUseTool = makeCanUseTool(ws, run);
  }

  // AskUserQuestion is intercepted before it runs (canUseTool, or the PreToolUse
  // hook in `auto` mode), so the tool never executes and the CLI's canned "the
  // user did not answer" cannot happen. `onUserDialog` is still registered — it
  // is the documented contract and costs nothing — in case a future SDK build
  // starts using it; it feeds the same pending-dialog map, so the browser side is
  // identical either way. (It does nothing on its own: the CLI fails closed on
  // any dialog_kind not also in supportedDialogKinds, and the tool needs its
  // toolConfig entry.)
  opts.supportedDialogKinds = ['askUserQuestion'];
  opts.toolConfig = { askUserQuestion: { previewFormat: 'html' } };
  opts.onUserDialog = (request, { signal }) => {
    log('INFO', `onUserDialog: ${request.dialogKind}`);
    return askQuestion(run, request.payload || {}, signal)
      .then((answer) => (answer ? { behavior: 'completed', result: answer } : { behavior: 'cancelled' }));
  };

  if (resuming) opts.resume = sessionId;

  /** Cache-inclusive context usage, pushed to this session's viewers after
   *  each result. */
  const reportContextUsage = async (q) => {
    try {
      const u = await q.getContextUsage();
      emit({
        type: 'context_usage',
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        autoCompactThreshold: u.autoCompactThreshold,
        autoCompactEnabled: u.isAutoCompactEnabled,
      });
      const limit = (u.isAutoCompactEnabled && u.autoCompactThreshold) || u.maxTokens;
      const pct = limit ? Math.round((u.totalTokens / limit) * 100) : 0;
      const detail = `context ${u.totalTokens}/${limit} tokens (${pct}%)` +
        ` maxTokens=${u.maxTokens} autoCompact=${u.isAutoCompactEnabled ? 'on' : 'off'}` +
        ` threshold=${u.autoCompactThreshold || 'n/a'}`;
      if (pct >= 90) log('WARN', `${detail} — near auto-compact; a turn may pause while it compacts`);
      else vlog(detail);
    } catch (e) { vlog(`getContextUsage failed: ${e?.message || e}`); }
  };

  log('INFO', `query start: mode=${run.permMode} effort=${opts.effort || 'default'} ` +
    `model=${model || 'default'} resume=${resuming} promptLen=${text.length}`);

  // Stall watchdog — the reported "chat hangs" symptom. If no SDK event arrives
  // for a while during an active run (long thinking, a slow tool, a retry, or
  // auto-compaction), log how long it has been quiet so the app log shows
  // whether it is truly stuck or just working.
  let lastEventAt = Date.now();
  let lastEventKind = 'start';
  const watchdog = setInterval(() => {
    if (abortController.signal.aborted) return;
    const idleS = Math.round((Date.now() - lastEventAt) / 1000);
    if (idleS * 1000 >= STALL_WARN_MS) {
      log('WARN', `query quiet for ${idleS}s (last event: ${lastEventKind}) — still awaiting the SDK`);
    }
  }, STALL_CHECK_MS);

  try {
    const q = query({ prompt: text, options: opts });
    for await (const event of q) {
      lastEventAt = Date.now();
      lastEventKind = event.type === 'system' ? `system/${event.subtype}` : event.type;

      if (event.type === 'system' && event.subtype === 'init') {
        run.sessionId = event.session_id;
        if (!resuming) { connState.sessionId = event.session_id; connState.pendingRunId = null; }
        // Whichever session anyone just resumed or created becomes the default
        // a fresh, unqualified connection lands on next (see sessions.js).
        setLastUsedSessionId(event.session_id);
        // Only the tab that started a brand-new chat needs to learn its id (to
        // persist it client-side) — nobody else could be viewing it yet.
        send(ws, { type: 'session', id: event.session_id });
        if (event.model) emit({ type: 'model', model: event.model });
        // Terminal-only commands (/exit, /statusline …) are dropped here rather
        // than in the browser, so there is one place that knows this is a
        // remote UI — see slash-commands.js.
        const commands = usableSlashCommands(event);
        if (commands) {
          runtime.cachedSlashCommands = commands;
          broadcast({ type: 'slash_commands', commands });
          const hidden = event.slash_commands.length - commands.length;
          vlog(`slash commands: ${commands.length} offered${hidden ? `, ${hidden} terminal-only hidden` : ''}`);
        }
        vlog(`init: session=${event.session_id} model=${event.model}`);

      } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
        const m = event.compact_metadata || {};
        log('INFO', `compaction (${m.trigger || 'manual'}): ${m.pre_tokens || '?'} → ${m.post_tokens || '?'} tokens`);
        emit({ type: 'compacted', trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens });
        await reportContextUsage(q);

      } else if (event.type === 'assistant') {
        for (const block of (event.message?.content || [])) {
          if (block.type === 'text' && block.text) {
            vlog(`text: ${block.text.length} chars`);
            emit({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            vlog(`tool_use: ${block.name}`);
            liveToolNames.set(block.id, block.name);
            emit({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          }
        }

      } else if (event.type === 'user') {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const raw = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b) => b.text || '').join('')
                : JSON.stringify(block.content);
            vlog(`tool_result: ${raw.length} chars${block.is_error ? ' (error)' : ''}`);
            // An answered question comes back as an error and must not be
            // rendered as one — see isQuestionAnswer().
            const answered = isQuestionAnswer(liveToolNames.get(block.tool_use_id), !!block.is_error, raw);
            liveToolNames.delete(block.tool_use_id);
            emit({ type: 'tool_result', id: block.tool_use_id, output: truncateOutput(raw),
              isError: !!block.is_error && !answered, answered });
          }
        }

      } else if (event.type === 'rate_limit_event') {
        // Subscription usage-limit telemetry. A 'rejected' five_hour is the
        // auto-continue trigger; warnings are surfaced but ignored.
        const info = event.rate_limit_info || {};
        vlog(`rate_limit: status=${info.status} type=${info.rateLimitType} ` +
          `resetsAt=${info.resetsAt || 'n/a'} util=${info.utilization ?? 'n/a'}`);
        emit({ type: 'rate_limit', status: info.status, rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt, utilization: info.utilization });
        if (info.status === 'rejected' && info.rateLimitType === 'five_hour' && info.resetsAt) {
          limitHit = { resetsAt: info.resetsAt, rateLimitType: info.rateLimitType };
          log('WARN', `usage limit reached (five_hour); resets at ${new Date(info.resetsAt * 1000).toISOString()}`);
        }

      } else if (event.type === 'result') {
        // Not trusted to mean the turn finished: a usage-limit rejection can be
        // followed by a 'result' claiming subtype:'success' (cost $0, 1 turn)
        // before the generator throws for real — confirmed live. `limitHit`, set
        // from the actual rate_limit_event, is what the `finally` block acts on.
        if (runtime.credentialsExpired) {
          runtime.credentialsExpired = false;
          broadcast({ type: 'auth_status', authenticated: true });
        }
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log('INFO', `result: ${event.subtype} in ${secs}s, ${event.num_turns} turns, ` +
          `$${(event.total_cost_usd || 0).toFixed(4)}`);
        emit({
          type: 'result',
          success: event.subtype === 'success',
          cost: event.total_cost_usd,
          turns: event.num_turns,
          inputTokens: event.usage?.input_tokens ?? 0,
          outputTokens: event.usage?.output_tokens ?? 0,
          cacheReadTokens: event.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: event.usage?.cache_creation_input_tokens ?? 0,
        });
        await reportContextUsage(q);
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const message = String(err?.message || err);
      log('ERROR', `query failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
      // A usage-limit rejection throws from HERE rather than ending quietly —
      // confirmed live, with wrapped text like "Claude Code returned an error
      // result: You've hit your session limit · resets …". None of that is a
      // fresh failure, so this branch does nothing when `limitHit` is set: the
      // `finally` block covers it, with no stale-session drop and no raw error
      // bubble on top of the notice.
      if (!limitHit) {
        if (isAuthError(message)) {
          // The SESSION is fine — keep it so the conversation resumes after
          // re-login. Dropping it here made a later "continue" start a new,
          // empty session.
          runtime.credentialsExpired = true;
          log('WARN', 'query failed on authentication — prompting re-login');
          broadcast({ type: 'auth_expired', subscription: isSubscriptionAuth() });
        } else if (resuming) {
          // A genuinely stale resume id: reset just *this tab's* pointer so its
          // next prompt starts fresh, rather than retrying the same bad id
          // forever. (A limit-hit session is not stale, and must keep its id —
          // it is exactly what auto-continue resumes from — but that path never
          // reaches here since `limitHit` is set.)
          connState.sessionId = null;
        }
        // Sent directly to the requesting tab rather than via emit(): it is the
        // one that needs to know its own request failed, regardless of whether
        // the session ever got far enough to have a real id or any viewers.
        send(ws, { type: 'error', message });
      }
    }
  } finally {
    clearInterval(watchdog);
    removeRun(run);
    if (!resuming) connState.pendingRunId = null;
    if (abortController.signal.aborted) {
      log('INFO', `query aborted by user after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      emit({ type: 'aborted' });
    }

    // The new or updated session (and its title) should appear in the list, for
    // every tab regardless of what it is currently viewing.
    broadcast({ type: 'sessions', sessions: listSessions() });

    // Anything the run just created — a new automation, a new entity — should be
    // linkable in the reply that announces it.
    refreshHaLinks().then(() =>
      broadcast({ type: 'ha_links', entities: runtime.haLinks.entities, automations: runtime.haLinks.automations }));

    if (limitHit && !abortController.signal.aborted) {
      autoContinue.handleLimitHit(limitHit, {
        model, effort,
        permissionMode: run.permMode,
        autoAttempts,
        sessionId: run.sessionId,
      });
    }
  }

  return run.sessionId;
}
