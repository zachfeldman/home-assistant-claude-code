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
 *     `isSecureContext` below, so the error names this instead of guessing.
 *   - Denied at the browser/OS level. Ordinary "no mic access" — fixable from
 *     the browser's own site-permission UI, or (on some OSes) system privacy
 *     settings, same as any other site asking for the microphone.
 *   - Denied by the *embedding* page. Home Assistant's ingress serves this
 *     app inside its own <iframe>, and a cross-origin iframe only gets
 *     microphone access if that outer page's iframe tag allows it — nothing
 *     in this app's own HTML can grant that from in here.
 */
import { promptInput } from './dom.js';
import { resizeTextarea, updateSendBtn } from './composer.js';
import { appendErrorBubble } from './transcript.js';

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SpeechRecognitionCtor;

// Repeatedly holding Space against an unfixable-by-retrying condition (no
// HTTPS, chief among them) would otherwise post an identical bubble into the
// chat on every single attempt.
let lastErrorMsg = '';
let lastErrorAt = 0;
function showVoiceError(msg) {
  const now = Date.now();
  if (msg === lastErrorMsg && now - lastErrorAt < 8000) return;
  lastErrorMsg = msg;
  lastErrorAt = now;
  appendErrorBubble(msg);
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
    showVoiceError(
      `Voice input needs HTTPS — this page is loaded over ${location.protocol.replace(':', '')}, and ` +
      'browsers refuse microphone access there entirely, for any site, with no per-site override. ' +
      'A Nabu Casa remote-access URL is already HTTPS; a local http:// address (even homeassistant.local) ' +
      'is not, and needs its own certificate (a reverse proxy, or Settings → System → Network) before this can work.',
    );
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
    showVoiceError(
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
