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
 *     and, if Nabu Casa remote access is already connected, links straight to
 *     its (already-HTTPS) URL rather than just describing what to set up. That
 *     URL comes from the server (HA's own Cloud status is WebSocket-only, not
 *     something this page can ask HA for directly), asked for lazily and only
 *     once this error has actually happened — see requestNabuCasaUrl() below.
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

// Asked once, the first time it would actually be useful (this same insecure-
// context error, below) — not on every page load, since most people are on
// HTTPS and would never need it. S.nabuCasaUrl starts undefined; connection.js
// fills it in from the server's reply.
let nabuCasaRequested = false;
function requestNabuCasaUrl() {
  if (nabuCasaRequested || !S.ws || !S.isConnected) return;
  nabuCasaRequested = true;
  S.ws.send(JSON.stringify({ type: 'nabu_casa_url' }));
}

// Only worth advertising where it will actually do something — the same
// "box is empty" condition below is also exactly when the placeholder shows.
if (voiceSupported) promptInput.placeholder += ' — hold Space to talk';
const idlePlaceholder = promptInput.placeholder;

let recognition = null;
let recording = false;
let baseText = '';   // finalized transcript so far, separate from the live interim tail

export function isRecording() { return recording; }

export function startVoiceInput() {
  if (!voiceSupported || recording) return;
  if (!window.isSecureContext) {
    if (shouldShowVoiceError('insecure-context')) {
      const intro = `Voice input needs HTTPS — this page is loaded over ${location.protocol.replace(':', '')}, ` +
        'and browsers refuse microphone access there entirely, for any site, with no per-site override.';
      if (S.nabuCasaUrl) {
        appendErrorBubbleWithLink(
          `${intro} Your Nabu Casa remote-access URL is already HTTPS:`,
          S.nabuCasaUrl,
          S.nabuCasaUrl.replace(/^https:\/\//, ''),
        );
      } else {
        appendErrorBubble(
          `${intro} A local http:// address (even homeassistant.local) needs its own certificate ` +
          '(a reverse proxy, or Settings → System → Network) before this can work.',
        );
      }
    }
    requestNabuCasaUrl();
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
