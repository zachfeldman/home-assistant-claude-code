/*
 * Push-to-talk: hold Space (bound from banners.js — only one module may own
 * promptInput.onkeydown) while the message box is empty to transcribe speech
 * into it via the browser's own SpeechRecognition. Nothing is sent anywhere
 * for this — no server involvement, no network request — so quality, latency
 * and language coverage are entirely whatever the browser itself ships.
 *
 * Not supported everywhere: Safari's coverage has historically been
 * inconsistent, and — worth knowing before assuming this is broken rather
 * than unavailable — a page running inside another site's <iframe>, which is
 * exactly how Home Assistant's ingress serves this app, only gets microphone
 * access at all if that outer page's own iframe tag allows it. There is
 * nothing this app can do about that from in here.
 */
import { promptInput } from './dom.js';
import { resizeTextarea, updateSendBtn } from './composer.js';
import { appendErrorBubble } from './transcript.js';

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SpeechRecognitionCtor;

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
    appendErrorBubble(
      err === 'not-allowed' || err === 'service-not-allowed'
        ? 'Microphone access was denied. If this is showing through Home Assistant’s ingress, ' +
          'the permission may need to be granted to the Home Assistant page itself, not this app.'
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
