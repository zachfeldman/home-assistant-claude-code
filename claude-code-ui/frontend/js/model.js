/*
 * The model dropdown, the context-usage meter, and the start-a-new-chat nudge.
 */
import { S } from './state.js';
import { modelSelect } from './dom.js';

// ── Model dropdown ───────────────────────────────────────────────────────────
// The dropdown in index.html carries the current models; these labels also cover
// older ids so a stored choice — or a model the SDK reports back — still renders
// with a friendly name via ensureModelOption() instead of a raw id string.
export const MODEL_LABELS = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
};
// Context size. Every message re-sends the whole conversation, so the cost of
// the *next* message grows with it — and in a large window, "% to
// auto-compact" can stay reassuringly low while a chat carries hundreds of
// thousands of tokens. So besides that percentage, absolute thresholds drive
// the colour and a "start a new chat" nudge. Fed by the SDK's
// query.getContextUsage() after each turn, and by the server's read of the
// transcript (`estimated`) the moment a chat is opened.
export const ctxTokensEl = document.getElementById('ctx-tokens');
const ctxNudgeEl = document.getElementById('ctx-nudge');
const ctxNudgeText = document.getElementById('ctx-nudge-text');

/** Tokens at which a chat is "getting big" (amber + nudge) and "very big" (red). */
export const CTX_NUDGE_TOKENS = 150_000;
export const CTX_STRONG_TOKENS = 300_000;

export function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 0 = fine, 1 = getting big, 2 = very big. */
export function ctxLevel(tokens) {
  if (tokens >= CTX_STRONG_TOKENS) return 2;
  if (tokens >= CTX_NUDGE_TOKENS) return 1;
  return 0;
}

export function updateCtxHint() {
  ctxTokensEl.classList.remove('ctx-warn', 'ctx-danger');
  if (!S.ctxUsage || !S.ctxUsage.totalTokens) {
    ctxTokensEl.classList.add('hidden');
    updateCtxNudge(0);
    return;
  }
  const { totalTokens, maxTokens, autoCompactThreshold, autoCompactEnabled, estimated } = S.ctxUsage;
  const compact = autoCompactEnabled && autoCompactThreshold;
  const limit = compact ? autoCompactThreshold : maxTokens;
  let text = `${estimated ? '~' : ''}${fmtTokens(totalTokens)} tokens in context`;
  let pct = 0;
  if (limit) {
    pct = Math.min(100, Math.round(totalTokens / limit * 100));
    text += compact ? ` · ${pct}% to auto-compact` : ` · ${pct}% of ${fmtTokens(maxTokens)}`;
  }
  const level = ctxLevel(totalTokens);
  // Nearly full is its own problem — the chat can appear to stall while it
  // compacts — so that still nudges toward /compact whatever the size.
  if (pct >= 95) text += ' · run /compact';
  if (pct >= 95 || level === 2) ctxTokensEl.classList.add('ctx-danger');
  else if (pct >= 80 || level === 1) ctxTokensEl.classList.add('ctx-warn');
  ctxTokensEl.textContent = text;
  ctxTokensEl.title = 'Every message re-sends the whole conversation, so each one costs more as this grows.';
  ctxTokensEl.classList.remove('hidden');
  updateCtxNudge(totalTokens);
}

// The nudge can be dismissed per chat; it comes back if the chat crosses into
// the next level. Remembered for this tab only — it is a reminder, not a setting.
function nudgeKey() { return `ctxNudgeDismissed:${S.activeSessionId || ''}`; }
function dismissedLevel() {
  try { return Number(sessionStorage.getItem(nudgeKey())) || 0; } catch { return 0; }
}

function updateCtxNudge(tokens) {
  if (!ctxNudgeEl) return;
  const level = ctxLevel(tokens);
  if (!level || !S.activeSessionId || level <= dismissedLevel()) {
    ctxNudgeEl.classList.add('hidden');
    return;
  }
  ctxNudgeText.textContent = `This chat is carrying ~${fmtTokens(tokens)} tokens, and every message re-sends all of it. ` +
    (level === 2 ? 'Each reply here now costs many times what it would in a fresh chat.'
                 : 'A new chat for the next task will be much cheaper.');
  ctxNudgeEl.classList.toggle('ctx-nudge-strong', level === 2);
  ctxNudgeEl.classList.remove('hidden');
}

export function dismissCtxNudge() {
  const level = ctxLevel(S.ctxUsage?.totalTokens || 0);
  try { sessionStorage.setItem(nudgeKey(), String(level)); } catch {}
  ctxNudgeEl?.classList.add('hidden');
}

export function ensureModelOption(id) {
  if ([...modelSelect.options].some((o) => o.value === id)) return;
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = MODEL_LABELS[id] || id;
  modelSelect.appendChild(opt);
}
