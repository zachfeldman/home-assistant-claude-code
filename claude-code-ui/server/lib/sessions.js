/*
 * Sessions, read from Claude Code's own on-disk store.
 *
 * Multi-session browsing is built on the canonical JSONL transcripts at
 * ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — the same files the CLI
 * writes, so a session started here can be picked up there and vice versa.
 *
 * Each browser connection tracks its own session (see ws-protocol.js) — but a
 * *fresh* connection with no preference of its own (a browser tab that has
 * never switched anywhere, or a reconnect with nothing in sessionStorage yet)
 * needs a sensible default rather than always landing on "new chat". That
 * default is `lastUsedSessionId` below: whichever session was most recently
 * switched to, resumed, or created, by anyone. It is a *default*, not a
 * shared pointer — a connection that already has its own preference (via
 * `?sessionId=`, sessionStorage) is never overridden by another tab changing
 * this.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';
import { STORE_DIR, ACTIVE_FILE } from './config.js';

export function sessionFile(id) {
  return path.join(STORE_DIR, `${id}.jsonl`);
}

let lastUsedSessionId = null;

export function getLastUsedSessionId() {
  return lastUsedSessionId;
}

export function setLastUsedSessionId(id) {
  lastUsedSessionId = id || null;
  try { writeFileSync(ACTIVE_FILE, JSON.stringify({ sessionId: lastUsedSessionId })); }
  catch (e) { console.warn('Could not save last-used session:', e.message); }
}

/** Load the persisted default at boot. A pointer to a session that no longer
 *  exists would default every fresh tab to an empty chat forever, so drop it. */
export function loadLastUsedSessionId() {
  try {
    if (existsSync(ACTIVE_FILE)) {
      lastUsedSessionId = JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')).sessionId || null;
    }
  } catch (e) { console.warn('Could not load last-used session:', e.message); }
  if (lastUsedSessionId && !existsSync(sessionFile(lastUsedSessionId))) {
    lastUsedSessionId = null;
  }
}

export function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('');
  return JSON.stringify(content);
}

/**
 * Slash commands (e.g. /compact) are recorded in the transcript as user messages
 * wrapped in <command-name>…/<local-command-stdout>… tags. They are plumbing,
 * not conversation, so they are dropped from the rendered history.
 */
export function isCommandEcho(text) {
  return typeof text === 'string' &&
    (text.includes('<command-name>') || text.includes('<local-command-stdout>'));
}

// The two messages formatQuestionDenial() can produce. Fixed strings, so
// matching them is safe — and only ever consulted for a tool_result whose
// tool_use isn't in `toolNames` (a transcript truncated above the call).
const QUESTION_ANSWER_RE = /^The user (answered your question\(s\):|closed the question dialog without answering\.)/;

/**
 * An AskUserQuestion is answered by *denying* the tool call with the answer as
 * the message, so it lands in the transcript as is_error:true on a perfectly
 * ordinary reply. That is a deliberate choice made for the model's benefit, not
 * a failure the reader should see in red.
 */
export function isQuestionAnswer(toolName, isError, text) {
  if (!isError) return false;
  if (toolName === 'AskUserQuestion') return true;
  return toolName === undefined && QUESTION_ANSWER_RE.test(text);
}

/** Cap a tool result so one chatty command cannot flood the transcript. */
export function truncateOutput(raw) {
  return raw.length > 4000 ? raw.slice(0, 4000) + '\n…[truncated]' : raw;
}

/**
 * Turn one stored JSONL line into render item(s), matching the live event
 * shapes. Each item carries `ts` (epoch ms) so the UI can show when a message
 * happened after a reload.
 *
 * `toolNames` is tool_use id → tool name, carried across the whole transcript by
 * parseSession: a tool_result line only ever carries the id.
 */
export function lineToItems(line, toolNames = new Map()) {
  const items = [];
  const msg = line.message;
  if (line.isMeta || line.isSidechain || line.isCompactSummary || !msg) return items;
  const ts = line.timestamp ? Date.parse(line.timestamp) || undefined : undefined;
  const push = (o) => items.push(ts ? { ...o, ts } : o);

  if (line.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim() && !isCommandEcho(content)) push({ kind: 'user', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) {
          if (!isCommandEcho(b.text)) push({ kind: 'user', text: b.text });
        } else if (b.type === 'tool_result') {
          const raw = blockText(b.content);
          const answered = isQuestionAnswer(toolNames.get(b.tool_use_id), !!b.is_error, raw);
          push({ kind: 'tool_result', id: b.tool_use_id, output: truncateOutput(raw),
            isError: !!b.is_error && !answered, answered });
        }
      }
    }
  } else if (line.type === 'assistant') {
    for (const b of (msg.content || [])) {
      if (b.type === 'text' && b.text) push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
    }
  }
  return items;
}

export function parseSession(id) {
  const file = sessionFile(id);
  if (!id || !existsSync(file)) return [];
  const items = [];
  const toolNames = new Map();
  for (const ln of readFileSync(file, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let obj; try { obj = JSON.parse(ln); } catch { continue; }
    items.push(...lineToItems(obj, toolNames));
  }
  return items;
}

// A title is the conversation's first user message, so once found it never
// changes — cache it rather than re-reading a (possibly tens-of-MB) transcript
// on every catalog refresh.
const titleCache = new Map();

export function sessionTitle(id) {
  if (titleCache.has(id)) return titleCache.get(id);
  const t = readSessionTitle(id);
  if (t) titleCache.set(id, t);
  return t;
}

function readSessionTitle(id) {
  try {
    for (const ln of readFileSync(sessionFile(id), 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      let obj; try { obj = JSON.parse(ln); } catch { continue; }
      if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) continue;
      const c = obj.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text || '') : '';
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t;
    }
  } catch {}
  return null;
}

export function listSessions() {
  if (!existsSync(STORE_DIR)) return [];
  const out = [];
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    let mtime = 0, size = 0;
    try { const st = statSync(path.join(STORE_DIR, f)); mtime = st.mtimeMs; size = st.size; } catch {}
    const title = sessionTitle(id);
    if (!title) continue;   // an empty shell the CLI left behind, not a conversation
    out.push({ id, title, updatedAt: mtime, contextTokens: sessionContextTokens(id, mtime, size) });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Context size, read from the transcript ───────────────────────────────────
// What the *next* message in a conversation will carry is the context the last
// assistant turn was given: its usage's input + cache-write + cache-read
// tokens, plus what it wrote back. Reading that off disk costs nothing — unlike
// query.getContextUsage(), it needs no run — so a chat's size can be shown the
// moment it is opened, before anyone pays to find out.

/** Context tokens per the last main-thread assistant usage in `lines` (oldest
 *  first) that actually reached the model, or null if there is none — or if
 *  a compaction came after it, since
 *  the size before a compaction says nothing about the size after one. */
export function contextTokensFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    let obj; try { obj = JSON.parse(ln); } catch { continue; }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') return null;
    if (obj.type !== 'assistant' || obj.isSidechain) continue;
    const u = obj.message?.usage;
    if (!u) continue;
    const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    // A turn that never reached the model — a usage-limit or API error the
    // CLI records as a synthetic assistant message — has all-zero usage. It
    // says nothing about the context, so keep looking for the real last turn.
    if (total) return total;
  }
  return null;
}

/** The last `bytes` of a file as whole lines (a partial first line is dropped). */
function tailLines(file, size, bytes) {
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift();
  return lines;
}

// Transcripts only grow at the end, and tool results (screenshots especially)
// make single lines huge, so look at a growing tail rather than the whole file.
const TAIL_STEPS = [1 << 20, 8 << 20, Infinity];
const ctxCache = new Map();   // id → { mtime, size, tokens }

/** A session's current context size in tokens, or null if unknown. `mtime` /
 *  `size` may be passed when the caller has already stat'd the file. */
export function sessionContextTokens(id, mtime, size) {
  if (!id) return null;
  const file = sessionFile(id);
  if (mtime === undefined || size === undefined) {
    try { const st = statSync(file); mtime = st.mtimeMs; size = st.size; } catch { return null; }
  }
  const hit = ctxCache.get(id);
  if (hit && hit.mtime === mtime && hit.size === size) return hit.tokens;
  let tokens = null;
  try {
    for (const step of TAIL_STEPS) {
      const lines = tailLines(file, size, Math.min(step, size));
      tokens = contextTokensFromLines(lines);
      if (tokens !== null || step >= size) break;
      // A compaction in the tail is a definite answer (unknown), not a reason to look further.
      if (lines.some((l) => l.includes('"compact_boundary"'))) break;
    }
  } catch { tokens = null; }
  ctxCache.set(id, { mtime, size, tokens });
  return tokens;
}

export function deleteSession(id) {
  titleCache.delete(id);
  ctxCache.delete(id);
  try { unlinkSync(sessionFile(id)); return true; }
  catch (e) { console.warn('Could not delete session:', e.message); return false; }
}
