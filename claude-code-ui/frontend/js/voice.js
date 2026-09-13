/*
 * Push-to-talk: hold Space (bound from banners.js — only one module may own
 * promptInput.onkeydown) while the message box is empty to transcribe speech
 * into it via the browser's own SpeechRecognition. Nothing is sent anywhere
 * for this — no server involvement, no network request — so quality, latency
 * and language coverage are entirely whatever the browser itself ships.
 *
 * Three reasons this can be unavailable even when the browser ships the API,
 * worth telling apart because only one of them is something a person here can
 * fix from inside Home Assistant, and none of them are bugs in this app:
 *
 *   - No HTTPS. Browsers refuse microphone access on an insecure origin
 *     (anything that is not `https:`, or `localhost`/`127.0.0.1`) categorically
 *     — no prompt, no per-site override, every attempt fails identically. This
 *     is the single most common cause for a local Home Assistant instance
 *     reached as plain `http://homeassistant.local`. Checked directly via
 *     `isSecureContext` below, so the error names this instead of guessing —
 *     and links either straight back to *this app*, reached through Nabu
 *     Casa's own (already-HTTPS) remote-access URL if already connected, or
 *     to the Home Assistant Cloud settings page to go connect it if not,
 *     rather than just describing what to go do. "Straight back to this app"
 *     specifically means `<nabuCasaUrl>/<this app's own Supervisor slug>` —
 *     not the bare domain (lands on the default dashboard) and not this
 *     page's own current URL either (the raw ingress proxy path 401s for
 *     anyone who did not just arrive via Home Assistant's own app-panel,
 *     which is exactly what a fresh cross-origin tab is) — see
 *     server/lib/self-slug.js for why. Both the slug and the Nabu Casa URL
 *     come from the server (Supervisor's own "who am I", and HA's Cloud
 *     status, which is WebSocket-only — neither is something this page can
 *     ask for directly); the Nabu Casa one is prefetched as soon as the
 *     connection opens (maybePrefetchNabuCasaUrl(), called from
 *     connection.js) so it is normally already known by the time anyone
 *     actually holds Space, with a short bounded wait as a fallback for a
 *     first attempt that beats the round trip.
 *   - Denied at the browser/OS level. Ordinary "no mic access" — fixable from
 *     the browser's own site-permission UI, or (on some OSes) system privacy
 *     settings, same as any other site asking for the microphone.
 *   - Denied by the *embedding* page. Home Assistant's ingress serves this
 *     app inside its own <iframe>, and a cross-origin iframe only gets
 *     microphone access if that outer page's iframe tag allows it — nothing
 *     in this app's own HTML can grant that from in here.
 */
import { S } from './state.js';
import { promptInput } from './dom.js';
import { resizeTextarea, updateSendBtn } from './composer.js';
import { appendErrorBubble, appendErrorBubbleWithLink } from './transcript.js';

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SpeechRecognitionCtor;

// Repeatedly holding Space against an unfixable-by-retrying condition (no
// HTTPS, chief among them) would otherwise post an identical bubble into the
// chat on every single attempt. Keyed rather than compared by the rendered
// text, since the HTTPS message's own text changes once a Nabu Casa URL
// arrives — the two must still count as the same complaint for throttling.
// Short enough that someone retrying every second or two still gets an
// occasional reminder it's not about to start working, rather than one
// bubble and then apparent silence.
const ERROR_THROTTLE_MS = 4000;
let lastErrorKey = '';
let lastErrorAt = 0;
function shouldShowVoiceError(key) {
  const now = Date.now();
  if (key === lastErrorKey && now - lastErrorAt < ERROR_THROTTLE_MS) return false;
  lastErrorKey = key;
  lastErrorAt = now;
  return true;
}

// Asked at most once per page load — not unconditionally on every connect,
// since most people are on HTTPS and would never need it. S.nabuCasaUrl
// starts undefined; connection.js fills it in from the server's reply.
let nabuCasaRequested = false;
function requestNabuCasaUrl() {
  if (nabuCasaRequested || !S.ws || !S.isConnected) return;
  nabuCasaRequested = true;
  S.ws.send(JSON.stringify({ type: 'nabu_casa_url' }));
}

/** Called from connection.js's onopen — fires the request the moment it can,
 *  well before a human could plausibly have noticed the page and tried
 *  push-to-talk, so the answer is normally already in by their first attempt. */
export function maybePrefetchNabuCasaUrl() {
  if (!window.isSecureContext) requestNabuCasaUrl();
}

// A first attempt that beats the prefetch above (a very fast interaction, or a
// slow/unreachable Home Assistant) still gets a real answer rather than
// silently missing the link — just bounded, so a dead connection cannot hang
// the error message indefinitely.
const NABU_CASA_WAIT_MS = 1200;
function resolveNabuCasaUrl() {
  if (S.nabuCasaUrl !== undefined) return Promise.resolve(S.nabuCasaUrl);
  requestNabuCasaUrl();
  return new Promise((resolve) => {
    const deadline = Date.now() + NABU_CASA_WAIT_MS;
    const poll = () => {
      if (S.nabuCasaUrl !== undefined) return resolve(S.nabuCasaUrl);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  });
}

// Only worth advertising where it will actually do something — the same
// "box is empty" condition below is also exactly when the placeholder shows.
if (voiceSupported) promptInput.placeholder += ' — hold Space to talk';
const idlePlaceholder = promptInput.placeholder;

let recognition = null;
let recording = false;
let baseText = '';   // finalized transcript so far, separate from the live interim tail

export function isRecording() { return recording; }

export async function startVoiceInput() {
  if (!voiceSupported || recording) return;
  if (!window.isSecureContext) {
    if (!shouldShowVoiceError('insecure-context')) return;
    const intro = `Voice input needs HTTPS — this page is loaded over ${location.protocol.replace(':', '')}, ` +
      'and browsers refuse microphone access there entirely, for any site, with no per-site override.';
    const url = await resolveNabuCasaUrl();
    // A second, near-simultaneous call (the OS auto-repeating a still-held key
    // while this one was awaiting) already found shouldShowVoiceError() closed
    // and returned — this is always the one call that gets to render.
    if (url) {
      // The bare domain lands on the default dashboard; this page's own
      // location.pathname (the raw ingress proxy URL, /api/hassio_ingress/
      // <token>/...) 401s instead — that token is minted per-session by Home
      // Assistant's own app-panel when it loads this app and the backend
      // proxy rejects a browser that arrived any other way. `/<selfSlug>` is
      // the app's actual sidebar panel route (Core's addon_panel.py registers
      // it there), which goes through that flow properly rather than trying
      // to skip it.
      appendErrorBubbleWithLink(
        `${intro} Your Nabu Casa remote-access URL is already HTTPS — reopen this chat through it:`,
        S.selfSlug ? `${url}/${S.selfSlug}` : url,
        url.replace(/^https:\/\//, ''),
      );
    } else {
      appendErrorBubbleWithLink(
        `${intro} A local http:// address (even homeassistant.local) needs its own certificate — a reverse ` +
        'proxy, or connecting Nabu Casa remote access, which is already HTTPS:',
        `${location.origin}/config/cloud`,
        'Home Assistant Cloud settings',
        '_top',   // same-origin HA path — reuse the already-authenticated tab, see appendErrorBubbleWithLink
      );
    }
    return;
  }
  recording = true;
  baseText = '';
  promptInput.classList.add('listening');
  promptInput.placeholder = 'Listening…';

  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) baseText = (baseText ? baseText + ' ' : '') + chunk.trim();
      else interim += chunk;
    }
    promptInput.value = (baseText + ' ' + interim).trim();
    resizeTextarea();
    updateSendBtn();
  };

  recognition.onerror = (e) => {
    const err = e.error;
    stopVoiceInput();
    if (err === 'no-speech' || err === 'aborted') return;   // released before saying anything
    if (!shouldShowVoiceError(err)) return;
    appendErrorBubble(
      err === 'not-allowed' || err === 'service-not-allowed'
        ? 'Microphone access was denied. This page is over HTTPS, so that rules out the most common ' +
          'cause — it\'s either your browser\'s own site permission, or, if this is showing through Home ' +
          'Assistant\'s ingress, a permission that needs granting to the Home Assistant page itself.'
        : `Voice input stopped (${err}).`,
    );
  };

  // A recognizer can end on its own (e.g. a silence timeout) before the key
  // is released; stopVoiceInput() is idempotent so this is safe either way.
  recognition.onend = () => stopVoiceInput();

  try {
    recognition.start();
  } catch {
    stopVoiceInput();
  }
}

export function stopVoiceInput() {
  if (!recording) return;
  recording = false;
  promptInput.classList.remove('listening');
  promptInput.placeholder = idlePlaceholder;
  if (recognition) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition.stop(); } catch {}
    recognition = null;
  }
  localStorage.setItem('draft', promptInput.value);
}
