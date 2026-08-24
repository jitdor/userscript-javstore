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

All settings and visited history stay in the userscript manager's local storage. The script does not send that data to an external service.

With "Fast-navigation safety net" enabled (the default), a click is also written to `sessionStorage` until the userscript manager confirms it stored the visit. That note lives in the tab only, holds nothing beyond the URL currently being opened, is removed as soon as the real save lands, and can be switched off in the settings panel.

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
- Optional userscript APIs: `GM_addValueChangeListener` and `GM_registerMenuCommand`. AdGuard does not implement either; the script polls for changes instead of being notified, and its own on-page control replaces the manager menu.
- `GM_getValue`/`GM_setValue` are supported in both the synchronous Tampermonkey style and the asynchronous GM4 style AdGuard uses.

The script depends on JavStore's current page structure. If the site changes, please [open an issue](https://github.com/jitdor/userscript-javstore/issues).

## Development

The distributable is [`javstore-full-layout-cleanup.user.js`](./javstore-full-layout-cleanup.user.js). Keep the userscript header version and the internal `SCRIPT_VERSION` value in sync for every release.

Releases publish themselves: a push to `main` whose `@version` header names a version with no release yet runs the tests and publishes that release, which is what `@updateURL`/`@downloadURL` point at. A push that does not bump the header is a no-op, so releasing a change means bumping `@version` and `SCRIPT_VERSION` and adding the matching `## <version>` section to `CHANGELOG.md` in the same pull request. The workflow can still be run manually to release from a branch.

`npm install && npm test` runs the storage-persistence suite. It loads the userscript into jsdom windows that share one asynchronous value store with no change notifications—an AdGuard-shaped engine—and asserts that history survives reloads, concurrent tabs, interrupted saves, and explicit removals.
