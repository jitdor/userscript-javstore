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
- Replays clicks whose save was interrupted by the page unloading, and records a visit when a detail page is opened from JavStore.
- Imports and exports settings, visited history, and per-card overrides as a JSON backup.
- Optionally mirrors settings and history to a Cloudflare Worker you own, syncing only what changed, so history survives a userscript-manager reinstall and follows you between devices.

By default all settings and visited history stay in the userscript manager's local storage, and the script does not send that data anywhere. Turning on cloud sync sends it to the worker you configure, and nowhere else.

With "Fast-navigation safety net" enabled (the default), a click is also written to `sessionStorage` until the userscript manager confirms it stored the visit. That note lives in the tab only, holds nothing beyond the URL currently being opened, is removed as soon as the real save lands, and can be switched off in the settings panel.

## Cloud sync (optional)

Userscript-manager storage is local to one device and AdGuard has been known to lose it across upgrades. Cloud sync keeps a copy of the history in a Cloudflare Worker that you deploy and own, where a Durable Object holds it in SQLite—[`worker/`](./worker) has the deploy steps and takes about five minutes.

Once it is deployed, open the `JVS` panel → **Cloud sync**, enter the worker URL and the access token you generated, tick the box, and save. Repeat on every device with the same URL and token.

- Each device syncs on page load, when its tab regains focus, a few seconds after a visit, on the interval you choose, and whenever you press **Sync now**. The panel's status line reports the last sync or the reason the last one failed.
- Devices exchange only what changed: each remembers the sequence number it last saw and the moment it last pushed, so an idle page load costs about 150 bytes each way rather than the whole history. The first sync on a device transfers everything.
- The worker applies the same rules as the local merge—newest timestamp wins per URL, tombstones and the clear/retention horizons outrank stale entries—so a device that has been offline for a week cannot overwrite what the others recorded, and clearing history on one device clears it everywhere instead of being undone. A device that pushes a stale entry is handed the winning one back.
- Because a Durable Object is single-threaded, each sync's read-merge-write is serialized and strongly consistent: two devices syncing in the same second queue behind one another rather than racing.
- The endpoint and token live only on the device they were entered on. They are never written into the synced document, never appear in an exported backup, and are not left in the page: the token box stays empty once a token is stored and only reports that one exists.
- A worker that is unreachable does not affect anything locally: history is still saved to the userscript manager, and the next sync picks it up.

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
- `GM_getValue`/`GM_setValue` are supported in both the synchronous Tampermonkey style and the asynchronous GM4 style AdGuard uses.

The script depends on JavStore's current page structure. If the site changes, please [open an issue](https://github.com/jitdor/userscript-javstore/issues).

## Development

The distributable is [`javstore-full-layout-cleanup.user.js`](./javstore-full-layout-cleanup.user.js). Keep the userscript header version and the internal `SCRIPT_VERSION` value in sync for every release.

Releases publish themselves: a push to `main` whose `@version` header names a version with no release yet runs the tests and publishes that release, which is what `@updateURL`/`@downloadURL` point at. A push that does not bump the header is a no-op, so releasing a change means bumping `@version` and `SCRIPT_VERSION` and adding the matching `## <version>` section to `CHANGELOG.md` in the same pull request. The workflow can still be run manually to release from a branch.

`npm install && npm test` runs the storage-persistence and cloud-sync suites. Both load the userscript into jsdom windows that share one asynchronous value store with no change notifications—an AdGuard-shaped engine—and assert that history survives reloads, concurrent tabs, interrupted saves, and explicit removals. The sync suite additionally runs the real worker from [`worker/src/worker.mjs`](./worker/src/worker.mjs): its Durable Object class executes against a `node:sqlite` database standing in for `ctx.storage.sql`, with each jsdom window acting as a separate device, so both halves of a sync are covered against real SQL.
