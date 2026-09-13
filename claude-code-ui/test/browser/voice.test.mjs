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
    await page.waitForFunction(
      () => document.getElementById('prompt-input').classList.contains('listening'), { timeout: 2000 });
    assert.match(await page.$eval('#prompt-input', (el) => el.placeholder), /Listening/);
    assert.equal(await page.evaluate(() => window.__voiceFake.started), true);
    await page.keyboard.up('Space');
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

    // Then the final result for that same utterance, plus a fresh interim tail.
    await page.evaluate(() => {
      window.__voiceFake.onresult({
        resultIndex: 0,
        results: [
          Object.assign([{ transcript: 'turn on the hall light' }], { isFinal: true }),
          Object.assign([{ transcript: ' please' }], { isFinal: false }),
        ],
      });
    });
    assert.equal(await page.$eval('#prompt-input', (el) => el.value), 'turn on the hall light please');

    await page.keyboard.up('Space');
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
