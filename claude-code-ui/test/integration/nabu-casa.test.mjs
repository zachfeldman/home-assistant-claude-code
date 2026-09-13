/*
 * The nabu_casa_url request voice.js makes on demand when push-to-talk hits
 * an insecure-origin error, so it can link straight to a Nabu Casa
 * remote-access URL when one is already connected. Home Assistant's Cloud
 * status is WebSocket-only (no REST equivalent), so this goes through the
 * same fake HA WebSocket the ha-tools CLI tests already use.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';
import { startFakeHa, TOKEN } from '../helpers/fake-ha.mjs';

describe('nabu_casa_url', () => {
  test('a connected remote UI is reported as its (https) URL', async () => {
    const ha = await startFakeHa({
      commands: { 'cloud/status': { remote_connected: true, remote_domain: 'abc123.ui.nabu.casa' } },
    });
    const h = await startServer({ env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl } });
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'nabu_casa_url' });
    const reply = await c.waitFor('nabu_casa_url');
    assert.equal(reply.url, 'https://abc123.ui.nabu.casa');
    await h.stop();
    await ha.close();
  });

  test('a configured but disconnected remote UI reports no URL', async () => {
    const ha = await startFakeHa({
      commands: { 'cloud/status': { remote_connected: false, remote_domain: 'abc123.ui.nabu.casa' } },
    });
    const h = await startServer({ env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl } });
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'nabu_casa_url' });
    const reply = await c.waitFor('nabu_casa_url');
    assert.equal(reply.url, null);
    await h.stop();
    await ha.close();
  });

  test('no Cloud integration (or any other failure) reports no URL rather than erroring', async () => {
    // No 'cloud/status' handler registered — fake-ha answers unknown_command,
    // exactly like a real instance with the cloud integration not loaded.
    const ha = await startFakeHa({});
    const h = await startServer({ env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl } });
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'nabu_casa_url' });
    const reply = await c.waitFor('nabu_casa_url');
    assert.equal(reply.url, null);
    await h.stop();
    await ha.close();
  });

  test('no SUPERVISOR_TOKEN reports no URL without attempting a connection', async () => {
    const h = await startServer({});   // no SUPERVISOR_TOKEN in env at all
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'nabu_casa_url' });
    const reply = await c.waitFor('nabu_casa_url');
    assert.equal(reply.url, null);
    await h.stop();
  });

  test('the answer is cached: two requests only make one cloud/status call', async () => {
    const ha = await startFakeHa({
      commands: { 'cloud/status': { remote_connected: true, remote_domain: 'abc123.ui.nabu.casa' } },
    });
    const h = await startServer({ env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl } });
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'nabu_casa_url' });
    c.send({ type: 'nabu_casa_url' });
    await c.waitFor(() => c.all('nabu_casa_url').length >= 2);
    assert.deepEqual(c.all('nabu_casa_url').map((m) => m.url),
      ['https://abc123.ui.nabu.casa', 'https://abc123.ui.nabu.casa']);
    assert.equal(ha.requests.filter((r) => r.ws === 'cloud/status').length, 1,
      'the second request should be served from cache, not a second WebSocket round trip');
    await h.stop();
    await ha.close();
  });
});
