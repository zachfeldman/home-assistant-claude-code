/*
 * Push-to-talk (voice.js / banners.js's Space handling). Real speech
 * recognition needs a microphone and, for Chrome's implementation, a live
 * network round trip to Google's own recognition service — neither available
 * in headless CI — so `window.SpeechRecognition` is replaced with a fake
 * before the page loads. That proves the wiring (the empty-box gate, the
 * visual "listening" state, interim/final transcript relay, stop-on-release)
 * deterministically; it cannot and does not prove real speech gets
 * transcribed, which nothing short of a live microphone could.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer } from '../helpers/server-harness.mjs';
import { startFakeHa, TOKEN } from '../helpers/fake-ha.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
const skip = executablePath ? false : 'no Chrome found (set CHROME_PATH)';

// Installed before every navigation in this file: a fake constructor with just
// enough surface for voice.js (continuous/interimResults/lang, start/stop,
// onresult/onerror/onend) plus a global handle the test drives directly,
// since there is no real recognizer to feed a result through.
const installFake = () => {
  window.__voiceFakeInstances = [];
  class FakeRecognition {
    constructor() { window.__voiceFakeInstances.push(this); window.__voiceFake = this; }
    start() { this.started = true; }
    stop() { this.stopped = true; if (this.onend) this.onend(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

describe('push-to-talk', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    h = await startServer({});
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluateOnNewDocument(installFake);
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('advertises itself in the placeholder once the fake is detected as supported', async () => {
    assert.match(await page.$eval('#prompt-input', (el) => el.placeholder), /hold Space to talk/);
  });

  test('holding Space on an empty box starts recording and shows it', async () => {
    await page.focus('#prompt-input');
    await page.keyboard.down('Space');
    try {
      await page.waitForFunction(
        () => document.getElementById('prompt-input').classList.contains('listening'), { timeout: 2000 });
      assert.match(await page.$eval('#prompt-input', (el) => el.placeholder), /Listening/);
      assert.equal(await page.evaluate(() => window.__voiceFake.started), true);
    } finally {
      // See the equivalent finally below: guarantees the next test (which
      // relies on the key already having been released) isn't left waiting
      // on a release that an assertion failure here would otherwise skip.
      await page.keyboard.up('Space');
    }
  });

  test('releasing Space stops it and restores the placeholder', async () => {
    await page.waitForFunction(
      () => !document.getElementById('prompt-input').classList.contains('listening'), { timeout: 2000 });
    assert.equal(await page.evaluate(() => window.__voiceFake.stopped), true);
    assert.match(await page.$eval('#prompt-input', (el) => el.placeholder), /hold Space to talk/);
    assert.doesNotMatch(await page.$eval('#prompt-input', (el) => el.placeholder), /Listening/);
  });

  test('interim and final results land in the box live', async () => {
    await page.focus('#prompt-input');
    await page.keyboard.down('Space');
    try {
      await page.waitForFunction(
        () => document.getElementById('prompt-input').classList.contains('listening'), { timeout: 2000 });

      // One interim-only event, matching how a real recognizer streams a guess
      // before committing to it.
      await page.evaluate(() => {
        window.__voiceFake.onresult({
          resultIndex: 0,
          results: [Object.assign([{ transcript: 'turn on the ' }], { isFinal: false })],
        });
      });
      assert.equal(await page.$eval('#prompt-input', (el) => el.value), 'turn on the');

      // Then the final result for that same utterance, plus a fresh interim tail
      // — voice.js itself joins baseText/interim with a space, so this fragment
      // (unlike the first, which the browser's own value already trims) must
      // not start with one of its own or the join doubles up.
      await page.evaluate(() => {
        window.__voiceFake.onresult({
          resultIndex: 0,
          results: [
            Object.assign([{ transcript: 'turn on the hall light' }], { isFinal: true }),
            Object.assign([{ transcript: 'please' }], { isFinal: false }),
          ],
        });
      });
      assert.equal(await page.$eval('#prompt-input', (el) => el.value), 'turn on the hall light please');
    } finally {
      // Guarantee the key is logically released even if an assertion above
      // throws — otherwise recording stays stuck open and poisons every test
      // after this one (their own Space presses would find isRecording()
      // already true and skip inserting a literal space, a confusing second
      // failure with nothing to do with whatever this test actually got wrong).
      await page.keyboard.up('Space');
    }
    await page.waitForFunction(
      () => !document.getElementById('prompt-input').classList.contains('listening'), { timeout: 2000 });
    // The transcript stays in the box for review — nothing here auto-sends it.
    assert.equal(await page.$eval('#prompt-input', (el) => el.value), 'turn on the hall light please');
  });

  test('once the box has text, Space types a literal space instead', async () => {
    await page.evaluate(() => { document.getElementById('prompt-input').value = ''; });
    await page.type('#prompt-input', 'hello');
    const before = await page.evaluate(() => window.__voiceFakeInstances.length);

    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.type('#prompt-input', 'world');

    assert.equal(await page.$eval('#prompt-input', (el) => el.value), 'hello world');
    assert.equal(await page.evaluate(() => window.__voiceFakeInstances.length), before,
      'no new recognizer should have been started with text already in the box');
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

// The harness itself serves over plain http://127.0.0.1 — a secure context
// regardless of scheme, since 127.0.0.1/localhost are always exempt — so the
// case that actually bit a real user (Home Assistant reached over plain HTTP,
// no SSL) needs isSecureContext forced off deliberately rather than relying
// on how this test server happens to be reached.
const installInsecureContext = () => {
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
};

describe('push-to-talk over an insecure origin', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    h = await startServer({});
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluateOnNewDocument(installFake);
    await page.evaluateOnNewDocument(installInsecureContext);
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('names HTTPS specifically on the very first attempt, links to Cloud settings, never starts a recognizer, and does not nag on every retry', async () => {
    await page.focus('#prompt-input');

    // No SUPERVISOR_TOKEN in this describe block (no fake HA either), so the
    // server resolves nabu_casa_url to null essentially immediately — this is
    // the "no Nabu Casa" branch, exercised on the very first hold thanks to
    // the prefetch on connect plus startVoiceInput's own bounded wait.
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.waitForSelector('.error-bubble a', { timeout: 2000 });
    const link = await page.$eval('.error-bubble a', (a) => ({ href: a.href, text: a.textContent, target: a.target }));
    assert.match(link.href, /\/config\/cloud$/);
    assert.equal(link.text, 'Home Assistant Cloud settings');
    assert.equal(link.target, '_top',
      '_blank would cold-boot a disconnected copy of the HA frontend, which loses the deep link to its own login redirect');
    assert.match(await page.$eval('.error-bubble', (el) => el.textContent), /needs HTTPS/);
    assert.equal(await page.$eval('#prompt-input', (el) => el.classList.contains('listening')), false,
      'must bail before ever starting a recognizer it cannot use');
    assert.equal(await page.evaluate(() => (window.__voiceFakeInstances || []).length), 0);

    const bubblesAfterFirst = await page.$$eval('.error-bubble', (els) => els.length);
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.$$eval('.error-bubble', (els) => els.length), bubblesAfterFirst,
      'retrying an unfixable-by-retrying condition should not post a duplicate bubble');
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('push-to-talk over an insecure origin, with Nabu Casa connected', { skip }, () => {
  let ha, h, browser, page, errors;
  before(async () => {
    ha = await startFakeHa({
      commands: { 'cloud/status': { remote_connected: true, remote_domain: 'abc123.ui.nabu.casa' } },
      rest: { 'addons/self/info': { data: { slug: 'dafc670d_claude-code-ui' } } },
    });
    h = await startServer({
      env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl, VERBOSE_LOGGING: 'true' },
    });
    // refreshSelfSlug() runs fire-and-forget at server startup; wait for it
    // before connecting, or the page's one-shot 'config' message could win
    // the race and carry a still-null selfSlug forever (nothing re-sends it).
    await h.waitForLog('self slug:');
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluateOnNewDocument(installFake);
    await page.evaluateOnNewDocument(installInsecureContext);
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
  });
  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
    if (ha) await ha.close();
  });

  test('links straight back to this app (not the bare domain) on the very first attempt', async () => {
    // Prefetched on connect (maybePrefetchNabuCasaUrl(), fired from
    // connection.js's onopen) well before this test's own interaction, and
    // startVoiceInput() awaits up to 1.2s for it regardless — either way,
    // there is no "too soon" case left to test for here, unlike a fixed
    // fire-and-forget request would have had.
    await page.focus('#prompt-input');
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.waitForSelector('.error-bubble a', { timeout: 2000 });
    const link = await page.$eval('.error-bubble a', (a) => ({ href: a.href, text: a.textContent, target: a.target }));
    assert.equal(link.href, 'https://abc123.ui.nabu.casa/dafc670d_claude-code-ui',
      'the bare domain lands on the default dashboard, and the raw ingress URL 401s for a session that never went through Home Assistant\'s own app-panel flow');
    assert.equal(link.text, 'abc123.ui.nabu.casa', 'link text stays just the domain — the path is implicit');
    assert.equal(link.target, '_blank', 'a genuinely external destination, unlike the Cloud-settings link above');
    assert.match(await page.$eval('.error-bubble', (el) => el.textContent), /needs HTTPS/);
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});
