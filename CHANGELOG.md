# Changelog

## 6.3.2

- Fix: a sync saves the history it pulled before recording the cursor that covers it. The cursor was written first, so a state write that was interrupted by a navigation—or refused by the userscript manager—left the device permanently past rows it had never stored: after a reload it asked only for changes after that cursor and those entries were never offered again.
- Fix: a merge that brings back only protective metadata—a tombstone, a newer clear-history or retention cutoff, a newer settings timestamp—is saved too. Such a merge removes nothing that is on screen, so it was treated as "nothing changed" and left unsaved while the cursor moved past it: the tombstone was lost, and a sibling tab holding an older snapshot could merge the deleted visit back in.

## 6.3.1

- Fix: a sync no longer gives up when the userscript manager refuses the cross-origin request. AdGuard can decline a `GM_xmlhttpRequest` that Tampermonkey allows—its `@connect` handling is not the same—and the fallback to `fetch` only ran when the API was missing altogether, never when it failed. A refusal is now retried through `fetch`, which the worker's CORS headers permit.
- Fix: the failure shown in the panel carries what the engine actually reported—a status when the worker answered one, the refusal text when the request never left the browser—rather than always reading "the worker could not be reached".

## 6.3.0

- Change: cloud sync now stores history in a Durable Object with SQLite storage instead of a KV namespace. A Durable Object is single-threaded and strongly consistent, so the read-merge-write each sync performs is serialized—two devices syncing in the same second queue behind one another rather than both merging into the same stale base, which is the window in which KV could drop one device's entries.
- Change: devices exchange only what changed. Each remembers the sequence number it last saw and the moment it last pushed, so an idle page load costs about 150 bytes each way instead of the whole document—roughly 450 KB once a history reaches the 5,000-entry cap.
- Add: an entry pushed by a device that is behind is answered with the winning entry, so it cannot stay wrong about it.
- Add: a history left behind in the 6.2.0 KV namespace is imported once, when the namespace is still bound.
- Add: a backup taken straight from the worker (`GET /state`) can be fed to "Import backup" as-is.
- Compatible in both directions during an upgrade: the worker still answers the 6.2.0 whole-document protocol, and a 6.3.0 device falls back to it when it finds an older worker, so devices and worker can be updated in either order.
- Note: the worker keeps up to 50,000 visited entries as an archive; a device still keeps its newest 5,000.

## 6.2.0

- Add: optional cloud sync. Settings, visited history, and per-card overrides can be mirrored to a Cloudflare Worker you deploy yourself (`worker/`), so history survives a userscript-manager reinstall and follows you between devices. Configure the endpoint and token under "Cloud sync" in the settings panel; sync is off until you do.
- Sync never replaces, it merges—on the worker as well as locally. A device pushes its whole document and gets the merged result back, so a device that has been offline cannot overwrite what the others recorded, an unmarked item is not resurrected, and "Clear visited history" propagates instead of being undone.
- The endpoint and token are stored per device, outside the synchronized document: they are never uploaded to the worker and never appear in an exported backup.
- The access token is never placed in the page: the settings panel lives in a shadow root the site's own scripts can read, so the token box stays empty and only reports whether a token is stored.
- A sync that changes nothing does not write to the KV namespace, so ordinary page loads cost a read and nothing else.
- Add: retention pruning now travels with the document as a cutoff, so expired entries are not handed back by another device.
- Fix: settings carry their own timestamp, so an empty store—or a device that has never changed a setting—can no longer reset another device to the defaults.
- Fix: the 5,000-item cap drops the same entries everywhere (oldest first, URL breaking a tie) rather than each store keeping a different 5,000.

## 6.1.0

- Fix: visited history could disappear after a while on engines without `GM_addValueChangeListener` (AdGuard among them). Every tab kept the snapshot it read at load time and wrote it back wholesale, so the longest-open tab silently overwrote everything the other tabs had recorded. State is now merged rather than replaced on every write: newest timestamp wins per URL, writes are queued so two save cycles cannot interleave, and removals are recorded as timestamps (per-URL tombstones, plus a reset marker for "Clear visited history") so a merge can never resurrect them.
- Fix: a click could be lost when the page unloaded before the asynchronous `GM_setValue` completed. Clicks are now also parked in a short-lived per-tab note and replayed on the next JavStore page load, and arriving on a detail page from a JavStore referrer records the visit on its own. The safety net can be turned off with the new "Fast-navigation safety net" setting.
- Fix: saves are verified by reading the value back, retried once, and reported in the settings panel, so a storage backend that silently drops a write no longer goes unnoticed.
- Fix: a single failed read or write no longer disables saving for the rest of the page's lifetime.
- Add: tabs re-read and merge stored state when they regain focus, and poll periodically when the userscript manager does not support change notifications.
- Add: the settings panel shows when state was last saved and warns when the 5,000-item cap is reached.

## 6.0.1

- Fix: visited tracking (and settings/overrides) could silently reset on every page load under userscript engines whose `GM_getValue`/`GM_setValue` are async aliases for the GM4 API (e.g. AdGuard) rather than the classic synchronous Tampermonkey-style calls. State loading and saving now correctly await these calls regardless of which style the host engine implements.

## 6.0.0

- Initial packaged GitHub release.
- Configurable word, substring, and regular-expression matching.
- Tint, blur, and hide protection modes with per-card overrides.
- Private visited-item tracking, filtering, retention, and cross-tab synchronization.
- Responsive settings controls with JSON backup import and export.
