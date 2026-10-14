/*
 * The context meter and the "start a new chat" nudge.
 *
 * A chat's size is read off its transcript by the server and shown the moment
 * the chat is opened — the whole point is to see it *before* paying for the
 * next message — so everything here happens without a single run, until the
 * last test proves the prompt still goes to the chat on screen.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

// 2 + 1000 + 400000 + 300 = 401,302 → "401k", past the 300k "very big" line.
const BIG_USAGE = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 400000, output_tokens: 300 };
const withUsage = (text, usage) =>
  assistantLine([{ type: 'text', text }], { message: { role: 'assistant', content: [{ type: 'text', text }], usage } });

describe('the context meter and new-chat nudge', { skip: executablePath ? false : 'no Chrome found (set CHROME_PATH)' }, () => {
  let h, browser, page, consoleErrors;

  before(async () => {
    h = await startServer({
      sessions: {
        'huge': [userLine('A very long conversation'), withUsage('a very long answer', BIG_USAGE)],
        'small': [userLine('A short conversation'), withUsage('short answer', { input_tokens: 5, cache_read_input_tokens: 2000, output_tokens: 10 })],
      },
      data: { 'active-session.json': { sessionId: 'huge' } },
      scenario: { runs: [{ steps: [{ text: 'Still here.' }] }] },
    });
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.bubble', { timeout: 5000 });
  });

  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
  });

  const switchTo = async (title) => {
    await page.click('#sessions-btn');
    await page.waitForSelector('#sessions-panel:not(.hidden)', { timeout: 5000 });
    await page.evaluate((t) => {
      [...document.querySelectorAll('.session-item')].find((el) => el.textContent.includes(t)).click();
    }, title);
    await page.waitForFunction(
      (t) => document.getElementById('messages').textContent.includes(t), { timeout: 5000 }, title);
  };

  test('opening a big chat shows its size straight away, in red, with no run', async () => {
    await page.waitForSelector('#ctx-tokens:not(.hidden)', { timeout: 5000 });
    const meter = await page.$eval('#ctx-tokens', (el) => ({ text: el.textContent, cls: el.className }));
    assert.match(meter.text, /~401k tokens in context/);
    assert.match(meter.cls, /ctx-danger/);
    assert.equal(h.records('query').length, 0);
  });

  test('and nudges toward a new chat', async () => {
    await page.waitForSelector('#ctx-nudge:not(.hidden)', { timeout: 5000 });
    const nudge = await page.$eval('#ctx-nudge', (el) => ({ text: el.textContent, cls: el.className }));
    assert.match(nudge.text, /~401k tokens/);
    assert.match(nudge.text, /New chat/);
    assert.match(nudge.cls, /ctx-nudge-strong/);
  });

  test('the sessions panel shows every chat\'s size', async () => {
    await page.click('#sessions-btn');
    await page.waitForSelector('#sessions-panel:not(.hidden)', { timeout: 5000 });
    const rows = await page.$$eval('.session-item', (els) => els.map((e) => e.textContent));
    assert.ok(rows.some((r) => /A very long conversation/.test(r) && /~401k tokens/.test(r)), rows.join(' | '));
    assert.ok(rows.some((r) => /A short conversation/.test(r) && /~2k tokens/.test(r)), rows.join(' | '));
    assert.ok(await page.$('.session-ctx.ctx-danger'), 'the big one is flagged');
    await page.click('#sessions-btn');
  });

  test('a small chat shows its size quietly and no nudge', async () => {
    await switchTo('A short conversation');
    await page.waitForFunction(
      () => /~2k tokens/.test(document.getElementById('ctx-tokens').textContent), { timeout: 5000 });
    const cls = await page.$eval('#ctx-tokens', (el) => el.className);
    assert.doesNotMatch(cls, /ctx-warn|ctx-danger/);
    assert.ok(await page.$('#ctx-nudge.hidden'));
  });

  test('dismissing the nudge keeps it hidden for that chat', async () => {
    await switchTo('A very long conversation');
    await page.waitForSelector('#ctx-nudge:not(.hidden)', { timeout: 5000 });
    await page.click('#ctx-nudge-dismiss');
    await page.waitForSelector('#ctx-nudge.hidden', { timeout: 5000 });

    await switchTo('A short conversation');
    await switchTo('A very long conversation');
    await page.waitForFunction(
      () => /~401k/.test(document.getElementById('ctx-tokens').textContent), { timeout: 5000 });
    assert.ok(await page.$('#ctx-nudge.hidden'), 'it did not come back');
  });

  test('a prompt still goes to the chat on screen', async () => {
    await page.select('#perm-mode', 'bypass');
    await page.type('#prompt-input', 'one more thing');
    await page.click('#send-btn');
    await page.waitForFunction(
      () => /Still here\./.test(document.getElementById('messages').textContent), { timeout: 8000 });
    assert.equal(h.records('query').at(-1).options.resume, 'huge');
  });

  test('the nudge\'s New chat button starts one, and the meter resets', async () => {
    // Re-show it: the dismissal is per chat, so clear it for this test.
    await page.evaluate(() => sessionStorage.clear());
    await switchTo('A short conversation');
    await switchTo('A very long conversation');
    await page.waitForSelector('#ctx-nudge:not(.hidden)', { timeout: 5000 });
    await page.click('#ctx-nudge-new');
    await page.waitForFunction(
      () => document.querySelectorAll('#messages .bubble-user').length === 0, { timeout: 5000 });
    assert.ok(await page.$('#ctx-nudge.hidden'));
    assert.ok(await page.$('#ctx-tokens.hidden'));
  });

  test('and the console stayed clean throughout', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
