/*
 * refreshSelfSlug() (server/lib/self-slug.js) and the selfSlug field it adds
 * to the 'config' message — voice.js's Nabu Casa link needs this app's own
 * full Supervisor slug to reopen the right sidebar panel (see there, and
 * Core's addon_panel.py, for why the raw ingress URL will not do).
 *
 * refreshSelfSlug() runs fire-and-forget at server startup (same as
 * refreshHaLinks()), so these wait for its own debug log line before
 * connecting — otherwise a fast test would race a real network round trip.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';
import { startFakeHa, TOKEN } from '../helpers/fake-ha.mjs';

describe('selfSlug', () => {
  test('resolves this app\'s own full slug and reports it in config', async () => {
    const ha = await startFakeHa({
      rest: { 'addons/self/info': { data: { slug: 'dafc670d_claude-code-ui' } } },
    });
    const h = await startServer({
      env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl, VERBOSE_LOGGING: 'true' },
    });
    await h.waitForLog('self slug:');
    const c = await h.connect();
    const cfg = await c.waitFor('config');
    assert.equal(cfg.selfSlug, 'dafc670d_claude-code-ui');
    await h.stop();
    await ha.close();
  });

  test('a Supervisor error reports null rather than throwing', async () => {
    const ha = await startFakeHa({ status: { 'addons/self/info': 500 } });
    const h = await startServer({
      env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl, VERBOSE_LOGGING: 'true' },
    });
    await h.waitForLog('self slug: /addons/self/info returned');
    const c = await h.connect();
    const cfg = await c.waitFor('config');
    assert.equal(cfg.selfSlug, null);
    await h.stop();
    await ha.close();
  });

  test('no SUPERVISOR_TOKEN reports null without attempting a request', async () => {
    const h = await startServer({});   // no SUPERVISOR_TOKEN in env at all
    const c = await h.connect();
    const cfg = await c.waitFor('config');
    assert.equal(cfg.selfSlug, null);
    await h.stop();
  });
});
