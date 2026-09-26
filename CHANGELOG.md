# Changelog

## 6.7.0

- Add: the Cloud sync panel shows which worker version the device is syncing with, taken from the worker's own answers. If the worker is behind the userscript, the line says so and asks you to redeploy it. Workers from 6.7.0 on send their version in every answer. Older workers are recognised from the shape of their answer: `6.6.0`, "older than 6.6.0", or "older than 6.3.0".
- Add: when the worker is newer than the userscript, an **⚠ Update script** button appears next to the JavStore controls. A newer worker means a newer release is out that the userscript manager hasn't installed yet. The button opens the panel, where a banner names both versions and links to the latest release so the manager can install it. It stays until the script catches up, and never shows for a worker that is level with or behind the script.
- Change: the worker's version now moves in step with the userscript's, and a test enforces it, because both deploy from the same commit.

## 6.6.0

- Fix: on AdGuard for Android, every refresh turned cloud sync off and wiped the history on that device. Setting sync up again pulled everything back and showed it, but the next refresh lost it all again. The script stored its history and sync settings as plain objects, but the GM4 API only promises to keep strings, numbers and booleans. AdGuard for Android sticks to that: while the page stays open it hands the object back, so the check after each save passed, but after a reload the key reads as empty. Every value is now stored as a JSON string and decoded when read. Values an older version stored as objects still load and are rewritten in the new form on the next save. What was already lost on such an engine cannot be recovered, but turning sync on again pulls the worker's copy back.
- Fix: synced settings now merge setting by setting, so a new install can no longer overwrite your filter keywords. Settings used to travel as one object, and the newest save won outright. A device that changed anything, even just the tint, before its first sync pushed its copy of every other setting too, including the default match terms and an empty excluded list, over what the other devices had. Each setting now carries its own timestamp, and only the settings you actually changed on a device are stamped when you save the panel. A setting a device never touched has no stamp and can never win, so a fresh install picks up the worker's keywords and keeps only what you changed on it. Two devices changing different settings keep both changes. **Restore defaults** and importing a backup still stamp every setting, because both deliberately set all of them.
- Change: the worker merges settings setting by setting in the same way, so it needs redeploying (`npx wrangler deploy` in `worker/`). Settings a worker already holds count as stamped at their old single timestamp, and a 6.5 or older device keeps the old whole-object behaviour. Until the worker is redeployed, the old worker still replaces the whole settings object.

## 6.5.0

- Fix: visits could vanish when several tabs saved at the same moment, which is exactly what Ctrl-clicking a row of tiles does: each click saves from the listing and each tab it opens saves again as it loads. Every save reads the whole history, merges, and writes the whole history back, and nothing makes that atomic across tabs, so a slow save built from an older read wrote back a document without a visit another tab had just stored. The merge could not catch it (the visit was never in what that tab read), and neither could the read-back check (the clobbering write really had landed). On a slow storage engine such as AdGuard's this happened often enough to leave gaps in the history, so the tiles already seen were not marked when the listing was reloaded.
- Change: each page now also writes what it records to a journal key of its own, which no other page writes. Every read folds all journals into the main document, so a visit a racing save dropped comes back on the next read, and the next save puts it back for good; a page load that finds a journal ahead of the main document saves straight away. A journal is removed once it has sat unchanged for ten minutes and a save that merged it has been read back in place. This needs `GM_listValues` and `GM_deleteValue`, which the script now requests; an engine without them keeps the single-document behaviour.
- Fix: a numbered category listing such as `/416-av-uncensored-page-2-cn.html` is no longer taken for an item page and recorded as a visit when it carries a heading of its own.

## 6.4.2

- Fix: a visit could be lost when a sibling tab's stale document landed between this tab's write and the read-back that checks it. The read-back then carries a newer timestamp, so the write looks good, while the visit it was meant to save has been clobbered out of it — and the replay note, the only copy left, was given up on that report. The note is now kept until the document that comes back from storage actually carries the click. This costs the visit outright when the tab does not navigate: an ordinary click replays the note on the page it opens, but Cmd-clicking a tile leaves the listing where it is, so a refresh is the next thing to read storage.
- Add: a visit that does not come back from storage after a save is reported on the console, so a storage engine quietly dropping writes leaves a trace.

## 6.4.1

- Fix: a visit recorded in one tab could be left on that device for good. A sync marks its moment and afterwards sends only entries stamped after it, but it built that claim from the tab's own in-memory copy of the history—and sibling tabs only ever write theirs to storage. So a tab that had not seen a visit another tab recorded would push nothing and still move the mark past it, and no later sync would ever offer that entry again: visited on the device that recorded it, absent on every other, and reported as "nothing new". A sync now merges the stored document before it decides what to send.
- Fix: an entry that reaches a device stamped in the past is no longer swallowed by the same mark. A click replayed from the previous page, a restored backup, or anything else adopted from storage behind the mark now pulls it back so the next sync rescans from there.
- Fix: "Import backup" no longer destroys the history it is restoring. It cleared the way with a full-history reset stamped at the moment of the import, and a backup is by definition older than that, so the worker and every other device dropped the restored entries on sight while the importing tab kept them—a device that looked restored and synced nothing. A restore now records what it drops entry by entry, so the removals still travel, and the backup's own timestamps survive.
- Fix: a sync that runs out of page budget with entries still to send no longer retires them unsent.
- Fix: a visit recorded while a sync was saving could not arm the push timer and waited for the next poll; it is now sent as soon as the sync finishes.
- Fix: a per-card override carrying no timestamp—as documents written by 6.0.0 and 6.1.0 do—is dated to the document it was found in rather than being refused by the worker forever.
- Fix: an override and a removal stamped at the same moment settle the same way on the device as on the worker, which is in the removal's favour.
- Change: "Sync now" reports both directions ("Synced: 3 sent up, remote history merged in"). It described only what had come down, so a device that was failing to push looked exactly like one with nothing to push.

## 6.4.0

- Fix: opening a card with the browser's own "open link in new tab" (right-click > open in new tab) now counts as a visit. The browser's context menu never tells the page which item was chosen—only a `contextmenu` event arrives, which is equally what "Copy link" or a dismissed menu looks like—so nothing was recorded, and only Ctrl/Cmd+click, middle-click and an ordinary click were, because those do send the page a click.
- Fix: arriving on an item page records the visit on the page's own evidence rather than on a referrer. A new tab need not carry one, and a listing links to the next listing, so a referrer never separated the two cases it was asked to.
- Fix: an item page that carries a strip of related cards is no longer read as a listing page and skipped. A page is taken for an item page when its URL is not a listing URL and it carries either a heading of its own or body text the cards do not account for; pages that say `og:type=article` are taken at their word.

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
