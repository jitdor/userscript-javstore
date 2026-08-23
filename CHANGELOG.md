# Changelog

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
