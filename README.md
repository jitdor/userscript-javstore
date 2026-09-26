# JavStore Full Layout Cleanup

A Tampermonkey userscript that cleans up JavStore's layout, protects keyword-matched thumbnails, and keeps a private visited-item history.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. [Install the latest release](https://github.com/jitdor/userscript-javstore/releases/latest/download/javstore-full-layout-cleanup.user.js).
3. Open [JavStore](https://javstore.net/). The compact `JVS` control appears on supported pages.

## Features

- Hides the sidebar and expands the main content area.
- Matches configurable terms using word, substring, or regular-expression rules.
- Protects matched thumbnails with tint, blur, or hide modes.
- Supports excluded terms and per-card allow/block overrides.
- Tracks visited cards with configurable retention and a 5,000-item cap.
- Filters the page to all, unvisited, visited, or matched cards.
- Reveals individual cards temporarily or toggles protection globally.
- Synchronizes settings and history across tabs, merging rather than overwriting, and falls back to polling when the userscript manager cannot notify tabs of changes.
- Replays clicks whose save was interrupted by the page unloading, and records a visit whenever an item page is opened—including by the browser's own "open link in new tab", which reaches the page as no click at all.
- Imports and exports settings, visited history, and per-card overrides as a JSON backup.
- Optionally mirrors settings and history to a Cloudflare Worker you own, syncing only what changed, so history survives a userscript-manager reinstall and follows you between devices.

By default all settings and visited history stay in the userscript manager's local storage, and the script does not send that data anywhere. Turning on cloud sync sends it to the worker you configure, and nowhere else.

With "Fast-navigation safety net" enabled (the default), a click is also written to `sessionStorage` until the userscript manager confirms it stored the visit. That note lives in the tab only, holds nothing beyond the URL currently being opened, is removed as soon as the real save lands, and can be switched off in the settings panel.

## Cloud sync (optional)

Userscript-manager storage is local to one device and AdGuard has been known to lose it across upgrades. Cloud sync keeps a copy of the history in a Cloudflare Worker that you deploy and own, where a Durable Object holds it in SQLite—[`worker/`](./worker) has the deploy steps and takes about five minutes.

Once it is deployed, open the `JVS` panel → **Cloud sync**, enter the worker URL and the access token you generated, tick the box, and save. Repeat on every device with the same URL and token.

- Each device syncs on page load, when its tab regains focus, a few seconds after a visit, on the interval you choose, and whenever you press **Sync now**. The panel's status line reports the last sync or the reason the last one failed.
- Devices exchange only what changed: each remembers the sequence number it last saw and the moment it last pushed, so an idle page load costs about 150 bytes each way rather than the whole history. The first sync on a device transfers everything.
- Tabs on one device share a history but not a sync. Before deciding what to send, a sync merges what the device has on disk, so a visit recorded in one tab is not passed over by another tab's sync; and an entry that turns up stamped before the last push—a click replayed from the previous page, a restored backup—pulls the mark back to itself rather than being left behind it.
- The worker applies the same rules as the local merge—newest timestamp wins per URL, tombstones and the clear/retention horizons outrank stale entries—so a device that has been offline for a week cannot overwrite what the others recorded, and clearing history on one device clears it everywhere instead of being undone. A device that pushes a stale entry is handed the winning one back.
- Because a Durable Object is single-threaded, each sync's read-merge-write is serialized and strongly consistent: two devices syncing in the same second queue behind one another rather than racing.
- Settings sync too, including the match and excluded terms, and they merge setting by setting: each one goes to the device that changed it last. A setting a device has never changed carries no timestamp and cannot win, so a new install picks up your keywords from the worker instead of pushing its defaults over them, even if you changed something else on it first. **Restore defaults** and a backup import set every setting on purpose, so they win everywhere.
- The Cloud sync panel shows the worker version from the worker's last answer. When the worker is behind the userscript, a **⚠ Redeploy worker** button appears on screen next to the JavStore controls; tap it for the versions and the deploy command. The worker does not deploy itself: run `npx wrangler deploy` in `worker/` after each release. When the worker is ahead instead, an **⚠ Update script** button appears on screen and links to the latest release, because the userscript manager has not installed it yet.
- AdGuard for Android clears a userscript's storage whenever it installs an update. After setting sync up, press **Copy sync link** and keep the link somewhere private, such as a password manager. After a wipe, open it on JavStore, or paste it into the endpoint box and save, to set everything up again. The link carries your token, so treat it like a password.
- The endpoint and token live only on the device they were entered on. They are never written into the synced document, never appear in an exported backup, and are not left in the page: the token box stays empty once a token is stored and only reports that one exists.
- A worker that is unreachable does not affect anything locally: history is still saved to the userscript manager, and the next sync picks it up.
- **Sync now** reports both directions—what went up and what came down—so a device that is failing to push is not mistaken for one with nothing to push.
- Restoring a backup keeps the backup's own timestamps and records the entries it drops as removals, so the restore reaches the other devices instead of being discarded by them. Entries a history clear already covers cannot be restored, and the panel says how many were skipped.

## Controls

- Click `JVS` to open the settings panel.
- Focus or hover a card, then press `R` to reveal it, `V` to toggle visited status, or `O` to cycle its override.
- Long-press a matched card on touch devices to reveal it.
- Press the configured global shortcut (default: `M`) outside form fields to reveal or protect all matched cards.
- Use the userscript manager menu to open settings or toggle all matched cards.

## Compatibility

- Target: `https://javstore.net/*`
- Run timing: `document-start`
- Required userscript APIs: `GM_addStyle`, `GM_getValue`, `GM_setValue`
- Cloud sync additionally uses `GM_xmlhttpRequest` with `@connect *`, because the worker URL is yours to choose. It is only called once sync is switched on; engines without it fall back to `fetch`, which the worker's CORS headers allow.
- Optional userscript APIs: `GM_addValueChangeListener` and `GM_registerMenuCommand`. AdGuard does not implement either; the script polls for changes instead of being notified, and its own on-page control replaces the manager menu.
- `GM_getValue`/`GM_setValue` are supported in both the synchronous Tampermonkey style and the asynchronous GM4 style AdGuard uses. Values are stored as JSON strings, because GM4 only promises to keep strings, numbers and booleans, and AdGuard for Android drops stored objects when the page reloads.
- `GM_listValues` and `GM_deleteValue` let each page keep its own journal of what it recorded, so tabs saving at the same moment cannot overwrite each other's visits. AdGuard and Tampermonkey provide both; an engine without them falls back to a single stored document.

The script depends on JavStore's current page structure. If the site changes, please [open an issue](https://github.com/jitdor/userscript-javstore/issues).

## Development

The distributable is [`javstore-full-layout-cleanup.user.js`](./javstore-full-layout-cleanup.user.js). Keep the userscript header version and the internal `SCRIPT_VERSION` value in sync for every release.

Releases publish themselves: a push to `main` whose `@version` header names a version with no release yet runs the tests and publishes that release, which is what `@updateURL`/`@downloadURL` point at. A push that does not bump the header is a no-op, so releasing a change means bumping `@version` and `SCRIPT_VERSION` and adding the matching `## <version>` section to `CHANGELOG.md` in the same pull request. The workflow can still be run manually to release from a branch.

`npm install && npm test` runs the storage-persistence and cloud-sync suites. Both load the userscript into jsdom windows that share one asynchronous value store with no change notifications—an AdGuard-shaped engine—and assert that history survives reloads, concurrent tabs, interrupted saves, and explicit removals. The store can be given random per-call latency, which is how the suite reproduces several tabs' saves overlapping on a slow engine. The sync suite additionally runs the real worker from [`worker/src/worker.mjs`](./worker/src/worker.mjs): its Durable Object class executes against a `node:sqlite` database standing in for `ctx.storage.sql`, with each jsdom window acting as a separate device, so both halves of a sync are covered against real SQL.
