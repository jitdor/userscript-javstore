# Changelog

## 6.0.1

- Fix: visited tracking (and settings/overrides) could silently reset on every page load under userscript engines whose `GM_getValue`/`GM_setValue` are async aliases for the GM4 API (e.g. AdGuard) rather than the classic synchronous Tampermonkey-style calls. State loading and saving now correctly await these calls regardless of which style the host engine implements.

## 6.0.0

- Initial packaged GitHub release.
- Configurable word, substring, and regular-expression matching.
- Tint, blur, and hide protection modes with per-card overrides.
- Private visited-item tracking, filtering, retention, and cross-tab synchronization.
- Responsive settings controls with JSON backup import and export.
