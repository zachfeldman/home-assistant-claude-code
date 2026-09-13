/*
 * AskUserQuestion.
 *
 * The SDK's own dialog transport (`onUserDialog`) is never actually reached for
 * this tool: the call completes inside the CLI subprocess with a canned "The
 * user did not answer the questions." and no request_user_dialog is ever sent,
 * whatever `toolConfig.askUserQuestion` declares. That is why the tool used to
 * be disallowed outright.
 *
 * It is driven by hand instead: intercept the call before it runs, put the
 * question to the browser, and turn whatever comes back into a *denial* whose
 * message is the user's answer. `canUseTool` has no "succeeded with this result"
 * shape, and a denial's message is what reaches the model as the tool result —
 * verified live: the model reads it as the answer and carries on normally.
 *
 * A pending question belongs to the run that asked it, not to a connection —
 * it lives on that run's own `pendingDialogs` map (state.js) so any tab
 * currently viewing that session may answer it, and a tab that switches to
 * view it later is shown the one still waiting (see ws-protocol.js).
 */
import { randomUUID } from 'crypto';
import { sendToSessionOrBroadcast } from './broadcast.js';
import { findRunByPendingId } from './state.js';

export function formatQuestionDenial(toolInput, result) {
  if (!result || !result.answers) {
    return {
      behavior: 'deny',
      message: 'The user closed the question dialog without answering. Ask again if you still need the answer, ' +
        'or carry on using your best judgement.',
    };
  }
  const lines = (toolInput.questions || []).map((q) => {
    const a = result.answers[q.header];
    const text = Array.isArray(a) ? a.join(', ') : (a || '(no answer given)');
    return `- ${q.header}: ${text}`;
  });
  return { behavior: 'deny', message: `The user answered your question(s):\n${lines.join('\n')}` };
}

/**
 * Put a question to whoever is viewing this run's session (or, if nobody is
 * right now, every connected tab) and wait — however long that takes.
 * Resolves with the raw answer payload, or null if it was skipped or aborted.
 *
 * Deliberately waits even with nobody connected right now (an unattended
 * auto-continue resume, or a phone mid-reconnect): a send to zero clients is a
 * no-op, and a client that connects/switches in later is shown every entry
 * still pending. The question is just as answerable in ten minutes, or
 * tomorrow, as it was the instant it was asked. The only things that end the
 * wait are an answer, Skip, or the run itself ending.
 */
export function askQuestion(run, toolInput, signal) {
  return new Promise((resolve) => {
    const id = randomUUID();
    run.pendingDialogs.set(id, { payload: toolInput, resolve });
    sendToSessionOrBroadcast(run.sessionId, { type: 'user_dialog', id, dialogKind: 'askUserQuestion', payload: toolInput });
    signal?.addEventListener('abort', () => {
      if (run.pendingDialogs.delete(id)) {
        // Without telling the clients, the question would sit on screen as
        // still-waiting after Stop had already ended the turn.
        sendToSessionOrBroadcast(run.sessionId, { type: 'user_dialog_cancelled', id });
        resolve(null);
      }
    }, { once: true });
  });
}

/** Answer a pending question, wherever it lives. Returns false if it is no
 *  longer waiting. */
export function answerDialog(id, result) {
  const run = findRunByPendingId('pendingDialogs', id);
  if (!run) return false;
  const entry = run.pendingDialogs.get(id);
  run.pendingDialogs.delete(id);
  sendToSessionOrBroadcast(run.sessionId, { type: 'user_dialog_cancelled', id });   // close it on every other viewer
  entry.resolve(result || null);
  return true;
}

/**
 * The `auto` permission mode is SDK-native and has no canUseTool, so the same
 * interception happens as a PreToolUse hook — which runs in every mode and
 * short-circuits the tool before it executes. `run` is bound in by
 * permissions.js's `hooksFor`, since a hook has no other way to know which
 * run it is running inside.
 */
export async function askQuestionHook(run, input, _toolUseID, options) {
  if (input?.tool_name !== 'AskUserQuestion') return { continue: true };
  const toolInput = input.tool_input || {};
  const answer = await askQuestion(run, toolInput, options?.signal);
  const denial = formatQuestionDenial(toolInput, answer);
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial.message,
    },
  };
}
