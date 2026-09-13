/*
 * How a tool call gets approved: the guard for other add-ons' config folder
 * (ADDON_CONFIGS_PATH, from config.js), and the canUseTool that backs the
 * ask / acceptEdits / bypass / plan modes.
 *
 * Two mechanisms, deliberately. A PreToolUse *hook* is used for the
 * ADDON_CONFIGS_PATH guard because it runs in **all** permission modes —
 * including `auto`, which has no canUseTool at all — and its deny
 * short-circuits the tool before it executes. canUseTool is used for
 * anything the user should be asked about, because only it can carry a
 * decision back from the browser.
 *
 * A pending permission prompt belongs to the run that asked it (its own
 * `pendingPermissions` map, state.js) rather than to a connection — a
 * headless run (auto-continue resuming with no browser open) needs the same
 * answerable-by-anyone behavior an interactive run gets, so there is no
 * longer a separate "headless" bucket: every run, however it started, has
 * one.
 */
import { randomUUID } from 'crypto';
import {
  ALLOW_ADDON_CONFIGS, ADDON_CONFIGS_PATH, ENABLE_ESPHOME, ESPHOME_CONFIG_DIR, EDIT_TOOLS,
} from './config.js';
import { log } from './log.js';
import { findRunByPendingId } from './state.js';
import { connections, send, sendToSessionOrBroadcast } from './broadcast.js';
import { askQuestion, formatQuestionDenial, askQuestionHook } from './dialogs.js';

/**
 * Render the SDK's suggested permission rules into a short human label for the
 * "Always" button (e.g. "Bash(git status:*)" or "Read").
 */
export function describeSuggestions(suggestions) {
  const rules = [];
  for (const s of suggestions || []) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && Array.isArray(s.rules)) {
      for (const r of s.rules) rules.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    } else if (s.type === 'setMode') {
      rules.push(`mode: ${s.mode}`);
    }
  }
  return [...new Set(rules)].join(', ');
}

/**
 * When ESPHome is enabled, its config folder under ADDON_CONFIGS_PATH is a
 * legitimate target even if broad access is off — but only that folder. A
 * tool call qualifies when every such reference in it is inside that dir.
 */
export function touchesOnlyEsphome(blob) {
  if (!ENABLE_ESPHOME || !ESPHOME_CONFIG_DIR) return false;
  const refs = blob.match(new RegExp(ADDON_CONFIGS_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[^"\'\\s)]+', 'g')) || [];
  return refs.length > 0 && refs.every((r) => r === ESPHOME_CONFIG_DIR || r.startsWith(ESPHOME_CONFIG_DIR + '/'));
}

/**
 * Matching the absolute path in the serialized tool input catches Read/Edit/Write
 * (file_path), Glob/Grep (path) and Bash (command) uniformly; nothing under
 * ADDON_CONFIGS_PATH is reachable from the /config cwd without naming that path.
 */
export function addonConfigsDenyHook(input) {
  const blob = JSON.stringify(input?.tool_input ?? '');
  if (!blob.includes(ADDON_CONFIGS_PATH)) return { continue: true };
  if (touchesOnlyEsphome(blob)) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Access to /addon_configs (other apps\u2019 configuration) is disabled. ' +
        'Turn on "Allow access to other app configs" in the app Configuration tab to enable it.',
    },
  };
}

// Registered only when access is disabled: with it enabled there is no guard to
// run, so this avoids a per-tool-call round trip to the subprocess.
const ADDON_CONFIGS_HOOK = ALLOW_ADDON_CONFIGS ? null : async (input) => addonConfigsDenyHook(input);

export const ADDON_CONFIGS_HOOKS = ADDON_CONFIGS_HOOK
  ? { PreToolUse: [{ hooks: [ADDON_CONFIGS_HOOK] }] }
  : undefined;

/** PreToolUse hooks for one run: the guard, plus the question interceptor in
 *  `auto` mode (bound to this run, since a hook has no other way to reach it). */
export function hooksFor(mode, run) {
  const pre = [];
  if (ADDON_CONFIGS_HOOK) pre.push(ADDON_CONFIGS_HOOK);
  if (mode === 'auto') pre.push((input, toolUseID, options) => askQuestionHook(run, input, toolUseID, options));
  return pre.length ? { PreToolUse: [{ hooks: pre }] } : undefined;
}

/** Resolve a prompt the user answered, wherever its run lives. */
export function resolvePermission(id, decision) {
  const run = findRunByPendingId('pendingPermissions', id);
  if (!run) return false;
  const entry = run.pendingPermissions.get(id);
  run.pendingPermissions.delete(id);
  entry.resolve(decision);
  return true;
}

/**
 * Switching to a more permissive mode mid-prompt should not leave a card on
 * screen that the new mode would now allow — scoped to the one run this
 * happened in, not every run across every tab.
 */
export function resolvePromptsAllowedBy(run, mode) {
  if (mode !== 'bypass' && mode !== 'acceptEdits') return;
  const permits = (toolName) => mode === 'bypass' || EDIT_TOOLS.has(toolName);

  for (const [id, entry] of run.pendingPermissions) {
    if (!permits(entry.toolName)) continue;
    run.pendingPermissions.delete(id);
    entry.resolve('allow');
    sendToSessionOrBroadcast(run.sessionId, { type: 'permission_resolved', id });
  }
}

/**
 * Build the canUseTool for one run.
 *
 * It reads `run.permMode` at call time rather than closing over the mode it
 * was built with, which is what makes switching modes mid-prompt take effect
 * immediately.
 */
export function makeCanUseTool(ws, run) {
  return (toolName, input, options) => {
    // A question is Claude asking the human something, not an action needing
    // approval — it never reaches the permission modes below.
    if (toolName === 'AskUserQuestion') {
      return askQuestion(run, input, options.signal).then((answer) => formatQuestionDenial(input, answer));
    }

    const mode = run.permMode;
    if (mode === 'bypass' || (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    // Plan mode: the SDK restricts the model to read-only tools, so allow those
    // silently and only prompt when it proposes leaving plan mode.
    if (mode === 'plan' && toolName !== 'ExitPlanMode') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    return new Promise((resolve) => {
      const id = randomUUID();
      // The SDK hands us `suggestions`: permission rules that would stop it
      // asking again for this kind of call (e.g. Bash(git status:*)). Handing
      // them straight back as `updatedPermissions` on an allow is what makes a
      // decision stick to the *tool* rather than to this one call.
      const suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
      const req = {
        type: 'permission_request',
        id,
        toolName,
        input,
        title: options.title,
        description: options.description,
        canAlways: suggestions.length > 0,
        alwaysLabel: describeSuggestions(suggestions),
      };

      if (ws.readyState === 1) {
        send(ws, req);
      } else if (connections.size > 0) {
        // No live originating socket (it navigated away, or this is a headless
        // auto-continue resume): ask whoever is viewing this session, or every
        // tab if nobody is.
        sendToSessionOrBroadcast(run.sessionId, req);
      } else {
        log('INFO', `permission needed for ${toolName} but no client is connected — denying`);
        resolve({ behavior: 'deny', message: 'No interactive client connected to approve this tool.' });
        return;
      }

      // 'allow' (this call) | 'always' (this call + persist the rule) | 'deny'
      const finish = (decision) => {
        if (decision === 'always' && suggestions.length) {
          log('INFO', `permission: always-allow ${describeSuggestions(suggestions)}`);
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions });
        } else if (decision === 'always' || decision === 'allow') {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          resolve({ behavior: 'deny', message: 'Denied by user' });
        }
      };

      run.pendingPermissions.set(id, { toolName, resolve: finish });
      options.signal.addEventListener('abort', () => {
        run.pendingPermissions.delete(id);
        resolve({ behavior: 'deny', message: 'Aborted' });
      }, { once: true });
    });
  };
}
