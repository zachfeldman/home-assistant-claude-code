## 1.11.14
- **Fixed the Nabu Casa remote-access link 401ing instead of reopening this app.** 1.11.12/13's approach — keeping this page's own current URL, the raw ingress proxy path (`/api/hassio_ingress/<token>/...`) — turned out to be exactly the wrong thing to preserve: verified against Home Assistant Core's own source that this URL is not a stable, bookmarkable link at all. It is minted per-session by Home Assistant's `ha-panel-app` component the moment it loads this app's panel, and the backend proxy rejects any request that arrived any other way — including a browser that navigated straight to a copied one. The link now points at `<nabu casa url>/<this app's own Supervisor slug>` instead — Core registers every app's sidebar panel at exactly that path (`addon_panel.py`: `frontend_url_path=addon`), which is the real, stable, session-establishing route back into it. The server asks Supervisor's own `/addons/self/info` for that slug once at startup (it cannot be hardcoded — it varies per install depending which repository this was added from) and reports it in the `config` message every tab already gets

## 1.11.13
- No app changes. 1.11.12's own new test tried to exercise a realistic ingress-style path by actually navigating there — but this test harness's server, unlike Supervisor's real ingress proxy, has no path-stripping in front of its `/ws` route, so that broke the page's own WebSocket connection outright (dom.js derives the socket URL from `location.pathname` too) and the test just timed out waiting for a bubble that could never appear. Connects at the root instead, then uses `history.pushState` to change what `location.pathname` reports without a real navigation — the already-open connection is untouched, and only the link-building logic under test reads the path

## 1.11.12
- **The Nabu Casa remote-access link now reopens this app itself, not your default dashboard.** It was pointing at the bare `https://*.ui.nabu.casa` domain, which — same as typing just a domain into any browser — lands on whatever your home dashboard is. Now keeps this page's own path (its ingress URL) alongside the swapped-in HTTPS domain, so clicking it takes you straight back to this same chat, reached securely, ready to actually try push-to-talk again

## 1.11.11
- **Fixed the Home Assistant Cloud settings link landing on the dashboard instead of Cloud settings.** `/config/cloud` (added in 1.11.10) was actually the right path all along — confirmed against Home Assistant's own "my link" redirect registry — but the link opened it with `target="_blank"`, a brand-new disconnected browser tab that has to cold-boot the entire HA frontend from scratch, which typically loses the requested deep link to its own login/redirect flow and lands on the dashboard instead. Now `target="_top"`: breaks out of this app's (unsandboxed — confirmed against Home Assistant's actual ingress panel source, `ha-panel-app.ts`) iframe and reuses the already-authenticated HA tab directly, so its router just switches views in place. The Nabu Casa remote-access link (a genuinely separate, external destination) is unaffected and still opens in a new tab

## 1.11.10
- **The Nabu Casa link now shows on the very first HTTPS error, not the second.** It's prefetched the moment the connection opens (well before anyone could plausibly have noticed the page and reached for the microphone), and the error itself now waits up to 1.2s for that answer if it somehow hasn't landed yet — rather than firing the request only when the error first happens and showing the plain text that one time regardless
- **No Nabu Casa connected? Now links to the Home Assistant Cloud settings page** (`/config/cloud`, same-origin since this app is ingress-only) **to go set it up**, instead of only mentioning it in passing text alongside the reverse-proxy option

## 1.11.9
- **The HTTPS error links straight to your Nabu Casa remote-access URL, if one is already connected.** Home Assistant's Cloud status only exists over its own WebSocket API — nothing this page can ask for on its own — so the server now answers an on-demand request for it (`cloud/status`, cached 5 minutes), asked for the first time this error actually happens rather than on every page load. No URL configured or connected, or Cloud unreachable for any reason? Falls back to the same descriptive text as before, exactly as if this had never been asked
- Shortened the identical-retry throttle from 8s to 4s — 8 was long enough that someone retrying every second or two would hit a stretch of apparent silence in between

## 1.11.8
- **Push-to-talk now names HTTPS specifically when that's the problem, instead of every hold-Space getting the same generic "access denied" bubble.** Browsers refuse microphone access on any plain-HTTP origin outright — no permission prompt, no per-site override, every single attempt fails identically — which is exactly what a Home Assistant instance reached as `http://homeassistant.local` (no SSL configured) hits every time. Checked directly via `isSecureContext` before ever touching the recognizer, so the message names the real cause and points at what actually fixes it (Nabu Casa remote access is already HTTPS; a local instance needs its own certificate — a reverse proxy, or Settings → System → Network)
- Also stopped re-posting an identical error bubble on every retry of a condition retrying can't fix — was flooding the chat with copies of the same message

## 1.11.7
- No app changes. `voice.test.mjs`'s own fixture put a leading space on an interim transcript fragment, which — added to the explicit separator `voice.js` already joins fragments with — doubled up and failed the assertion, which in turn skipped the `keyboard.up('Space')` after it, leaving the *next* test to find recording already stuck on and its own Space press silently swallowed (a real-looking but unrelated second failure). Fixed the fixture and wrapped both tests that hold Space in `try/finally` so a future assertion failure releases the key regardless, rather than cascading into whatever runs next

## 1.11.6
- **Push-to-talk.** Hold Space, while the message box is empty, to transcribe speech into it via the browser's own SpeechRecognition — release to stop, review, and send as usual (nothing auto-sends). Once the box has anything typed in it, Space goes back to just being a space, so this never gets in the way of normal typing. Browser-only: no audio leaves your device, nothing server-side changed. Not supported everywhere (Safari's coverage has historically been inconsistent), and if this app is showing through Home Assistant's ingress iframe, microphone access depends on permissions granted to the *Home Assistant* page, not this one — a denial says so rather than failing silently

## 1.11.5
- No app changes. `interactions.test.mjs`'s remaining new test asserted the run it abandoned would leave a transcript file on disk — CI's real Chrome caught that this harness's scripted SDK stub never writes one (that's the real Agent SDK's job, entirely absent from these tests), so it always timed out. Rewritten to switch a second connection into the abandoned session and wait for its `result` over the wire instead, the same idiom `test/integration/questions.test.mjs` already established for "does an unwatched run's state reach a tab that switches in"

## 1.11.4
- **Ctrl+Enter now actually inserts a newline.** 1.11.3 shipped this relying on the textarea's own default handling of a Ctrl-chorded Enter, which — CI's real headless Chrome caught this within the hour — Chrome does not treat as a newline by default (Shift+Enter, also added in 1.11.3, does default to a newline and was fine). Now inserted by hand instead of assumed
- Two of 1.11.3's own new browser tests had bugs of their own, also caught the same way: the "abandoned turn" test read `sessionStorage` for the run's session id *after* two earlier tests had already switched chats and overwritten it (always `undefined`) — now captured once, before any switching happens. And the background run's own 300ms completion could land mid-click on the sessions panel, detaching the node Puppeteer had just selected — lengthened so it reliably outlasts the clicks in this block, and finishes in the last test only

## 1.11.3
- **Enter sends; Ctrl+Enter (or Shift+Enter) inserts a newline.** Previously it was the other way round — plain Enter added a line break and only Ctrl/Cmd+Enter sent. Placeholder text updated to match
- **Deleting a conversation asks in the app again, not the browser.** The concurrent-tabs refactor (1.11.0) quietly swapped the styled confirmation dialog for a plain native `confirm()`, which — being a blocking browser-native dialog — could also leave the page's own event loop stuck if a test (or an extension, or anything else driving the page) didn't know to dismiss it. Unrelated to the session-switching warning removed in 1.11.2: deleting still destroys the conversation and aborts its run if one is active, so still worth confirming
- `test/browser/interactions.test.mjs` brought back in line with the concurrent-session behavior 1.11.0 actually shipped (see 1.11.2) — it was still asserting the old "asks before switching/starting a new chat" model, which is why CI's advisory browser-tests job has been red for the last two releases without anyone noticing. Replaced with tests for what the app actually does now, including one that reads a switched-away-from session's transcript straight off disk to confirm the run really did keep going and finished unsupervised. New coverage added for the Enter/Ctrl+Enter swap above

## 1.11.2
- **Removed the "starting a new chat will stop what it's doing" warning again — for real this time.** `1.11.1` restored it as a byproduct of fixing the crash below, but it no longer describes what happens: since concurrent sessions (1.11.0), leaving a session's turn running and starting/switching to another doesn't stop it — the turn keeps running server-side and is still there when you come back via Sessions. The warning was correct for the old single-run model 1.11.0's "asks first" bullet describes, not the concurrent-run model that same release actually shipped. The new-chat button and `/new` now just switch, same as clicking a different chat in Sessions already did

## 1.11.1
- **Fixed the app failing to load entirely.** `1.11.0` was the first release actually built from this fork (see 1.11.0 below) and shipped a leftover reference to a function deleted during the concurrent-tabs refactor, which made the browser throw a module-load error before anything on the page could wire itself up — every button, including Send, was dead and the console showed a JS error. Restored the missing function — but restored it with its old warning intact, wrong per the note above; fixed properly in 1.11.2
- Noted for next time: the headless-Chrome browser tests (`npm run test:browser`), which load the page for real and would have caught this, are advisory-only in CI (`continue-on-error: true`) and don't gate publishing. `test/browser/interactions.test.mjs` still has several cases asserting the old single-run "asks first" behavior this release removed — worth a pass to bring the suite in line with 1.11.0/1.11.2's actual behavior, and worth reconsidering the advisory-only gating given this shipped two releases in a row without it catching either issue

## 1.11.0
- **Switching to another chat while Claude is working now asks first — later removed in the same release, see 1.11.2.** Picking a past conversation from Sessions silently stopped the turn in progress, which looked exactly like the reply having been lost. It said what would happen and waited for you, and the same warning covered the new-chat button and `/new` — until the concurrent-tabs work below, landed the same day, removed the underlying behavior it was warning about
- **`ha-tools config-check` catches the errors it used to miss.** It reported "valid" for a config Home Assistant would load *without* the entity you had just written: a bad option in a `template:` or platform entry doesn't stop the config loading, it just makes Home Assistant drop that entity and carry on — and the endpoint the check relied on never mentioned it. Claude followed the tool's own advice, reloaded, and moved on believing a blind was set up that did not exist. The check now reads what Home Assistant logs *while it is checking*, names the file, line and key, and fails
- **`ha-tools reload` verifies the reload instead of the phone call.** It used to report success whenever the request went through. It now surfaces the same errors, and `--expect <entity_id>` will fail if the entity you just wrote doesn't actually appear
- **Two browser tabs can now run two different conversations at once.** Previously every tab shared one active session and one in-flight query — switching chats in one tab switched it for everyone, and a prompt in one tab could abort a run in another. Each tab now tracks its own conversation; one person with several tabs open still lands back on the same chat by default
- **Fixed Supervisor installs of this fork silently running upstream's unmodified image.** `config.yaml` still pointed at `xionic`'s published image after forking, so this fork's own commits — including the concurrent-tabs work above — were never actually deployed. Now points at this fork's own image

## 1.10.0
- **Updated to the current Claude Code engine** (Agent SDK 0.3.237, from 0.3.165 — about two and a half months of fixes and model updates). Nothing changes in how the app is used
- **The slash-command menu only lists commands that do something here.** Commands that exist to control a terminal — `/exit`, `/statusline` and the like — were being offered in the browser, where there is no terminal to exit; they are now filtered out
- **Claude can ask you questions properly again.** When it needs a decision it now puts the options on screen — one question per screen, with an "Other" box for when none of them fit — instead of burying the question in a paragraph of text. It had been switched off because the question never actually reached the browser; it's now intercepted before it runs, so the answer reliably gets back to Claude. A question **waits indefinitely** — backgrounding the app or letting your phone sleep no longer answers it "closed without answering" behind your back; it's still there, on the strip above the message box, whenever you come back
- **A question or permission prompt can be set aside without answering it.** Close it with ✕ and the chat is yours to read; a bar above the message box keeps the request and takes you back to it when you've worked out the answer. Nothing is decided for you, and the turn stays paused
- **Usage limits now say what happens next, where you'll actually see it — and actually get detected.** A limit can throw its own error *after* falsely reporting the turn as successful, which was slipping past detection entirely: no notice, nothing scheduled, and the conversation wrongly marked stale (so the next message started a new chat instead of continuing it — nothing was lost, but it looked like it). The chat now gets a note at the exact point it stopped — when the limit resets, and whether anything is going to pick it up — and if auto-continue is off, the bar above the message box offers to switch it on for *this* limit rather than only the next one
- **Runs of tool calls fold away as they happen**, not once the turn ends — a long turn no longer unfurls into a wall of tool calls before tidying itself up. The folded row names the call that's running right now, and afterwards which tools ran and whether any failed
- **↑ / ↓ arrows to step through your own messages** in a long chat, at the top and bottom right. They appear when you scroll and fade again when you stop
- **Fixed the controls scrolling out of reach on a mobile browser** — scrolling the chat past its end no longer drags the Home Assistant page (and this app's own header) away with it
- **Claude can read your Home Assistant logs again.** Home Assistant 2025.11 stopped writing `home-assistant.log` and removed the API this app used to read it, so the "Recent Errors" section of Claude's startup context had quietly been showing `404: Not Found` instead of your actual errors. It now reads the real log
- **New `ha-logs` tool** — Claude can pull the Core, Supervisor, host, or any app's log on demand (`ha-logs --errors`, `ha-logs self`, `ha-logs app_core_mosquitto`), so "why did my automation fail last night?" can actually be answered. Previously it had no way to reach the logs at all
- A failed log fetch now says so plainly in Claude's context rather than passing the error text off as log content
- **Claude can now debug automations properly.** New `ha-timeline` merges several entities' state changes onto one clock (`ha-timeline light.hall binary_sensor.stairs --days 3 --between 22:00-07:00`) — the "what happened, in what order?" question behind most automation timing bugs, which previously meant Claude writing a throwaway script every time
- **Safe automation edits end to end** — `ha-tools config-check` checks your config's syntax and structure before a reload (and fails loudly if it won't load at all), `ha-tools reload` applies it without restarting HA, and `ha-tools automation show` / `yaml` show what HA actually has loaded versus what's in your `automations.yaml`
- **`ha-tools trace-watch` waits for an automation to genuinely fire** and reports what happened — including runs that its conditions blocked, which is usually the answer when "it just doesn't work". Previously the only way to test a changed trigger was to physically trigger it and hope Claude was still watching
- **Times are consistent everywhere now.** Every helper prints your Home Assistant timezone with an explicit offset (`2026-08-12 23:27:42+01:00`) instead of a mix of raw epoch numbers and UTC — Claude was converting between three different formats by hand, one arithmetic slip away from quietly telling you the wrong time
- **All of Claude's Home Assistant helpers are now one `ha-tools` command** — `ha-tools history / stats / lovelace / logs`, plus `ha-tools ws` for entity states and service calls. `ha-tools --help` lists everything in one place, so Claude can check what it has instead of guessing. Nothing you or Claude already use changes: `ha-history`, `ha-stats`, `ha-lovelace` and `ha-logs` still work exactly as before, as names for the same command

## 1.9.3
- Model picker updated to the current Claude models: **Opus 5** and **Sonnet 5** replace Opus 4.8 and Sonnet 4.6 (Haiku 4.5 is unchanged). If you'd already picked an older model it keeps working and still shows by name — switch in **Settings → Model** to move up
- The Home Assistant suggestions subagent now runs on Sonnet 5

## 1.9.2
- Wording brought in line with Home Assistant's current terminology — add-ons are **apps**, and the install steps in the README now match the real path (**Settings → Apps → Install app → ⋮ → Repositories**). Thanks to Sir_Goodenough on the community forum for flagging it
- Folder mappings updated to Home Assistant's current names (`homeassistant_config` and `all_app_configs`), replacing the deprecated `config` / `all_addon_configs`. Nothing moves inside the app — Home Assistant's config stays at `/config` and other apps' configs at `/addon_configs`. **Now requires Supervisor 2026.07 or newer**
- Fixed the chat jumping to the bottom while you were reading it — a background reconnect replayed the whole conversation, which lost your scroll position and dragged the view down
- Removed the scroll-to-bottom animation when the chat loads; it now opens at the bottom instantly instead of visibly racing down from the top

## 1.9.1
- Composer redesigned so the attach and send buttons sit on their own row below the text — the typing area now spans the full width, like the Claude app
- Fixed attaching **multiple** photos silently failing on mobile (files the picker reported as zero-size were being dropped)
- Attached images are now downscaled before sending, so photos upload far faster and many fit at once (also normalizes formats like HEIC)

## 1.9.0
- **Attach images, photos, and files** to a message — via the paperclip button, pasting a screenshot, or drag-and-drop. Claude reads them (it sees images/PDFs and reads text/code). On mobile the picker offers the camera and photo library

## 1.8.3
- Fixed: after re-authenticating in a long chat, typing "continue" started a new empty session instead of resuming — an auth failure no longer discards the current session

## 1.8.2
- Fixed the sign-in code box vanishing when you switch to the browser and back during (re-)authentication — an in-progress login is now restored on reconnect, and login success is detected only when fresh credentials are written

## 1.8.1
- When your Claude sign-in expires, the chat now shows a "Session expired" screen with a Sign-in button to re-authenticate, instead of just failing with an error

## 1.8.0
- ESPHome build dependencies (patch, compilers, etc.) now install automatically when ESPHome is enabled and reinstall after app upgrades, so compiles keep working without manual apt installs

## 1.7.2
- Fixed the mobile header jittering up and down when scrolling near the bottom of a long chat

## 1.7.1
- App option descriptions trimmed to one or two sentences

## 1.7.0
- **Fixed a host-crash risk from ESPHome builds:** ESPHome/PlatformIO write multi-GB, tens-of-thousands-of-files build caches under `/data`, which the nightly backup was tarring — the tiny-file IO storm starved the host watchdog and hard-reset the Pi. Those caches are now **excluded from backups** (`backup_exclude`), and compiles run at **idle CPU/IO priority** (`nice`/`ionice`) so a build can't starve the host. Caches still persist under `/data` for fast rebuilds
- **Copy button on code blocks and tool output** — hover (or tap on mobile) any code block or tool result to copy it
- **Auto-hiding header on mobile** — on small screens the top bar slides away as you scroll down a long chat and reappears the moment you scroll up, so you don't have to scroll to the very top to reach settings. On larger screens it stays pinned

## 1.6.0
- **ESPHome support** (new `enable_esphome` option, off by default): bundles the ESPHome CLI so Claude can validate, compile, OTA-flash, and stream device logs for boards you manage with the ESPHome app — working directly on that app's config folder. Ships as an opt-in capability module (its own skill + the `esphome` tool); the toolchain installs in the background on first enable, and compilers download on the first build
- The app now runs on a **Debian base** (was Alpine) — required so the ESPHome/PlatformIO compilers can run. No user-visible change beyond that

## 1.5.2
- Fixed: **Plan** can now be set as the default permission mode in the app options. It was offered in the app's dropdown but rejected by the options schema, so you could pick it per-chat but never default to it

## 1.5.1
- Entity links now open **inside** Home Assistant instead of bouncing you out to a web page — clicking an entity opens its usual more-info dialog (a switch gets its toggle, a thermostat its controls, a sensor its history), and automations/dashboards navigate the app without a page reload

## 1.5.0
- **"Always" on permission prompts** — Allow now only covers that one call; the new **Always** button makes the decision stick to the tool so it stops asking (uses the SDK's own suggested permission rules, shown on the prompt so you can see exactly what you're allowing)
- **Home Assistant deep links in replies** — entity ids Claude mentions become links: automations open their editor, other entities open their history. Links open the real HA page outside the app's frame, and only real entities are linked (YAML blocks are left alone)

## 1.4.0
- **Auto-continue on usage limit** (new Settings toggle): when you're signed in with a Claude subscription and hit the 5-hour usage limit mid-response, the app can automatically resume the conversation once the limit resets — no need to come back and nudge it. A banner shows the countdown (with a Cancel), the scheduled resume survives an app/HA restart, and it's off by default. Only offered on subscription sign-in (an API key has no reset time to schedule against); the 7-day limit is not auto-resumed.

## 1.3.1
- Chat no longer auto-scrolls to the bottom when you've scrolled up to read or copy something — incoming responses only pull the view down if you're already at the bottom (sending a prompt re-pins you there)

## 1.3.0
- **Plan mode** added to the permission dropdown — Claude researches read-only and proposes a plan before making changes; you approve the plan to proceed
- **Reasoning effort** selector in Settings (Low → Max) so you can trade speed for depth per chat
- **Message timestamps** — a compact time now appears on each message (live and after a reload)
- **Working indicator shows elapsed seconds** on long turns, so a quiet stretch (deep thinking, a slow tool, or compaction) reads as "still going" rather than stuck
- **Context warning** — the token indicator turns amber, then red with a "run /compact" nudge as the window fills
- **New-dashboard support** — `ha-lovelace create`/`delete` let Claude make and remove Lovelace dashboards (previously it could only edit existing ones)
- **/compact no longer clutters the chat** — the slash-command echo (`<command-name>…`) is filtered from the transcript
- **App logging** — query start/end (with duration), compaction, errors, and a stall watchdog now log to the app log; a new **Verbose logging** option adds per-event detail for diagnosing hangs

## 1.2.0
- New **Allow access to other app configs** option (off by default): when enabled, Claude can read and edit other apps' config folders under `/addon_configs`; while disabled, any tool call touching that path is blocked at the tool layer (enforced in every permission mode, including Auto)

## 1.1.0
- AskUserQuestion no longer fails with a red X: the tool is disabled at the SDK level so Claude asks questions in conversational text instead
- Context indicator now shows real, cache-inclusive usage and **% toward auto-compaction** (from `query.getContextUsage()`) rather than an undercounted input+output figure
- Compaction is now visible — a "Context compacted" divider appears when `/compact` or auto-compaction runs, and the context indicator updates immediately
- CLAUDE.md is now user-editable and persistent: generated HA context moves to `~/.claude/ha-context.md` (refreshed each start) and is `@`-imported by a `~/.claude/CLAUDE.md` that the app seeds once and never overwrites

## 1.0.4
- Context token indicator above the input box shows how many tokens the next send will consume and what % of the model's context window that represents

## 1.0.3
- /usage now shows token counts (input, output, cache read/write, total) and explains what turns means

## 1.0.2
- Typed-but-not-submitted text is preserved when navigating away and back

## 1.0.1
- Markdown rendering in chat responses — tables, code blocks, headers, bold/italic, lists, and inline code now display correctly

## 1.0.0
- Multi-session support, find-in-chat, model/permission persistence, and UX improvements
