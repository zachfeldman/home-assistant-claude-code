/*
 * This app's own full Supervisor slug — asked for once at startup, the same
 * way refreshHaLinks() populates its own runtime state (see server/index.js).
 *
 * Needed because Home Assistant registers an app's sidebar panel at exactly
 * `/<slug>` (Core's addon_panel.py: `frontend_url_path=addon`) — the one
 * stable, session-establishing URL that reopens this app's own ingress view
 * from outside it. The raw ingress proxy path shown in the browser's address
 * bar (`/api/hassio_ingress/<token>/...`) looks like it should work the same
 * way but does not: that token is minted per-session by Home Assistant's own
 * `ha-panel-app` when it loads the panel, and the backend proxy 401s any
 * request that never went through that flow — including a browser that
 * navigated straight to a copied/bookmarked ingress URL. `/<slug>` is a real
 * frontend route, so it goes through that flow properly instead.
 *
 * The slug is `<repository-hash>_<config.yaml slug>` — varies per install
 * depending which repository it was added from — so it cannot be hardcoded;
 * `/addons/self/info` is Supervisor's own answer to "what am I".
 */
import { SUPERVISOR_URL } from './config.js';
import { vlog } from './log.js';
import { runtime } from './state.js';

export async function refreshSelfSlug() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return;
  try {
    const res = await fetch(`${SUPERVISOR_URL}/addons/self/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { vlog(`self slug: /addons/self/info returned ${res.status}`); return; }
    const body = await res.json();
    runtime.selfSlug = body?.data?.slug || null;
    vlog(`self slug: ${runtime.selfSlug}`);
  } catch (e) {
    vlog(`self slug fetch failed: ${e.message}`);
  }
}
