// ==UserScript==
// @name         JavStore Full Layout Cleanup - No Sidebars + Mosaic Overlay
// @namespace    http://tampermonkey.net/
// @version      6.9.0
// @description  Clean up JavStore's layout, filter keyword-matched thumbnails, and track visited items with private, configurable controls.
// @homepageURL  https://github.com/jitdor/userscript-javstore
// @supportURL   https://github.com/jitdor/userscript-javstore/issues
// @downloadURL  https://github.com/jitdor/userscript-javstore/releases/latest/download/javstore-full-layout-cleanup.user.js
// @updateURL    https://github.com/jitdor/userscript-javstore/releases/latest/download/javstore-full-layout-cleanup.user.js
// @match        https://javstore.net/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @grant        GM.addStyle
// @grant        GM.xmlHttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '6.9.0';
    // The same address as @downloadURL: opening it hands the newest release to the
    // userscript manager, which offers to install it.
    const INSTALL_URL = 'https://github.com/jitdor/userscript-javstore/releases/latest/download/javstore-full-layout-cleanup.user.js';
    const STORAGE_VERSION = 3;
    const STORAGE_KEY = 'javstore_cleanup_state_v2';
    const LEGACY_STORAGE_KEY = 'javstore_seen_links';
    const PENDING_VISITS_KEY = 'javstore_pending_visits';
    // Each page keeps its own journal under this prefix; see "Per-page journals" below.
    const JOURNAL_KEY_PREFIX = 'javstore_journal_v1_';
    // How long a journal outlives the last write that could have depended on it. A
    // read-merge-write cycle takes well under a second even on a slow engine, so this is
    // generous; it only bounds how many stale journal keys can pile up.
    const JOURNAL_TTL_MS = 10 * 60000;
    // The sync endpoint and its token are deliberately kept outside the synchronized
    // document: they are per-device credentials, so they neither travel to the worker nor
    // end up in an exported backup.
    const SYNC_CONFIG_KEY = 'javstore_sync_config_v1';
    const MAX_VISITED_ITEMS = 5000;
    const MAX_PENDING_VISITS = 50;
    const MAX_TOMBSTONES = 2000;
    const TOMBSTONE_TTL_MS = 90 * 86400000;
    const SYNC_POLL_MS = 45000;
    const REMOTE_PUSH_DEBOUNCE_MS = 4000;
    const REMOTE_REFRESH_MIN_GAP_MS = 60000;
    const REMOTE_TIMEOUT_MS = 20000;
    const REMOTE_PAGE_ROWS = 1000;
    const MAX_SYNC_PAGES = 12;
    const NON_ITEM_PATH = /^\/(?:page|search|tag|tags|category|categories|login|logout|register|profile|user|feed|rss)(?:\/|$)/i;
    // Category listings carry their page number in the slug, as in
    // `/416-av-uncensored-page-2-cn.html`.
    const LISTING_PAGE_PATH = /-page-\d+(?=[-.\/]|$)/i;
    const CARD_SELECTOR = 'main .grid a[href]';
    // A page that says it is an article says so about itself; a listing page does not.
    const ITEM_PAGE_META = 'meta[property="og:type"][content="article"], meta[property="article:published_time"]';
    // How much text outside the cards makes a page carrying cards an item page rather than
    // a listing, in characters. A listing's own text is a heading and its pagination; an
    // item page has a description and a file list above whatever related cards follow.
    const MIN_ITEM_TEXT = 400;

    const DEFAULT_SETTINGS = Object.freeze({
        keywords: ['mosaic', 'mozaic', 'moza'],
        excludedKeywords: [],
        matchStrategy: 'word',
        mode: 'tint',
        tintColor: '#dc0000',
        tintOpacity: 0.45,
        blurAmount: 16,
        revealDuration: 2000,
        revealDelay: 1000,
        recoverDuration: 200,
        toggleKey: 'm',
        trackVisited: true,
        fastNavigationSafety: true,
        visitedOpacity: 0.7,
        retentionDays: 0,
        hideSidebar: true,
        overlayLifted: false,
        filter: 'all',
    });

    const DEFAULT_SYNC_CONFIG = Object.freeze({
        enabled: false,
        endpoint: '',
        token: '',
        intervalMinutes: 5,
        // Where this device is up to with the worker. Local to the device, like the
        // credentials: `cursor` is the last sequence number it has seen, `pushedAt` the
        // moment of its last successful push, and `remoteKey` the endpoint both belong to.
        cursor: 0,
        pushedAt: 0,
        remoteKey: '',
    });

    const VALID_MODES = new Set(['tint', 'blur', 'hide']);
    const VALID_FILTERS = new Set(['all', 'unvisited', 'visited', 'matched']);
    const VALID_STRATEGIES = new Set(['word', 'substring', 'regex']);

    let settings;
    let visited = new Map();
    let overrides = new Map();
    let overrideTimes = new Map();
    let tombstones = new Map();
    let resetAt = 0;
    let prunedBefore = 0;
    let settingsUpdatedAt = 0;
    // When each setting was last changed on purpose, keyed by setting name. Settings merge
    // field by field on these, so changing one setting on one device does not carry that
    // device's copy of every other setting along with it; `settingsUpdatedAt` is the
    // newest of them, kept for documents and workers that predate the per-field stamps.
    let settingTimes = {};
    let lastKnownUpdatedAt = 0;
    let lastSavedAt = 0;
    let lastSaveFailed = false;
    let writeQueue = Promise.resolve(false);
    let syncConfig = { ...DEFAULT_SYNC_CONFIG };
    let remoteQueue = Promise.resolve(false);
    let pendingHorizonWrite = Promise.resolve();
    let remotePushTimer = 0;
    let remotePollTimer = 0;
    let lastRemoteAttemptAt = 0;
    let lastRemoteSyncAt = 0;
    // What the worker said it is on the last answer this page got, or what its answer's
    // shape gives away when it is too old to say.
    let remoteWorkerVersion = '';
    let lastRemoteError = '';
    let remoteSyncRunning = false;
    let applyingRemoteState = false;
    // A merge can absorb protective metadata—a tombstone, a newer `resetAt`, `prunedBefore`
    // or `settingsUpdatedAt`—without removing anything that is on screen, so
    // `mergeStoredState` reports "nothing visibly changed" while the document is now
    // different. That still has to reach storage, so the last merge also records whether it
    // adopted anything at all.
    let lastMergeAdopted = false;
    // The oldest entry the last merge took on that the push horizon has already moved
    // past. Such an entry would never be offered to the worker again, so the horizon is
    // pulled back to it; `mergeStoredState` only reports it, because it also runs while
    // remote rows are being folded in, where the horizon must not move at all.
    let lastMergeBackdatedTo = 0;
    // The oldest timestamp among the entries the last merge took on, whatever the push
    // horizon: a merge of rows that came from outside local storage has to be carried by
    // this page's journal back to there.
    let lastMergeOldest = 0;
    // A local change made while a sync was writing could not arm the push timer, because
    // arming it there would have the sync push its own merge straight back. The change
    // still has to go up, so the sync re-arms it once it is done.
    let deferredRemotePush = false;
    let syncTimer = 0;
    let storageAvailable = true;
    // This page's journal: its key, the oldest timestamp it still has to carry, and the
    // verified saves that may later let it carry less. See "Per-page journals" below.
    const journalKey = `${JOURNAL_KEY_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let journalSince = Date.now();
    let journalCheckpoints = [];
    let journalLowerings = 0;
    let journalWritten = false;
    let observer = null;
    let ui = null;
    let selectedCard = null;
    let countsQueued = false;
    const longPressTimers = new Map();
    const suppressNextClick = new WeakSet();

    function clamp(value, minimum, maximum, fallback) {
        const number = Number(value);
        return Number.isFinite(number)
            ? Math.min(maximum, Math.max(minimum, number))
            : fallback;
    }

    function stringList(value, fallback = []) {
        const source = Array.isArray(value) ? value : fallback;
        return [...new Set(source
            .map(item => String(item).trim())
            .filter(Boolean))]
            .slice(0, 100);
    }

    function sanitizeSettings(value = {}) {
        const candidate = value && typeof value === 'object' ? value : {};
        return {
            keywords: stringList(candidate.keywords, DEFAULT_SETTINGS.keywords),
            excludedKeywords: stringList(candidate.excludedKeywords),
            matchStrategy: VALID_STRATEGIES.has(candidate.matchStrategy)
                ? candidate.matchStrategy
                : DEFAULT_SETTINGS.matchStrategy,
            mode: VALID_MODES.has(candidate.mode) ? candidate.mode : DEFAULT_SETTINGS.mode,
            tintColor: /^#[0-9a-f]{6}$/i.test(candidate.tintColor || '')
                ? candidate.tintColor
                : DEFAULT_SETTINGS.tintColor,
            tintOpacity: clamp(candidate.tintOpacity, 0.1, 0.9, DEFAULT_SETTINGS.tintOpacity),
            blurAmount: clamp(candidate.blurAmount, 2, 40, DEFAULT_SETTINGS.blurAmount),
            revealDuration: clamp(candidate.revealDuration, 0, 5000, DEFAULT_SETTINGS.revealDuration),
            revealDelay: clamp(candidate.revealDelay, 0, 5000, DEFAULT_SETTINGS.revealDelay),
            recoverDuration: clamp(candidate.recoverDuration, 0, 2000, DEFAULT_SETTINGS.recoverDuration),
            toggleKey: String(candidate.toggleKey || DEFAULT_SETTINGS.toggleKey).trim().slice(0, 1).toLowerCase()
                || DEFAULT_SETTINGS.toggleKey,
            trackVisited: candidate.trackVisited !== false,
            fastNavigationSafety: candidate.fastNavigationSafety !== false,
            visitedOpacity: clamp(candidate.visitedOpacity, 0.4, 1, DEFAULT_SETTINGS.visitedOpacity),
            retentionDays: clamp(candidate.retentionDays, 0, 3650, DEFAULT_SETTINGS.retentionDays),
            hideSidebar: candidate.hideSidebar !== false,
            overlayLifted: candidate.overlayLifted === true,
            filter: VALID_FILTERS.has(candidate.filter) ? candidate.filter : DEFAULT_SETTINGS.filter,
        };
    }

    function normalizeUrl(value) {
        try {
            const url = new URL(value, location.href);
            url.hash = '';
            url.search = '';
            if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
            return url.href;
        } catch (error) {
            return String(value || '');
        }
    }

    function parseVisited(value) {
        const result = new Map();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
        Object.entries(value).forEach(([url, timestamp]) => {
            const normalized = normalizeUrl(url);
            const time = Number(timestamp);
            if (normalized && Number.isFinite(time) && time > 0) result.set(normalized, time);
        });
        return result;
    }

    function parseTimestamp(value) {
        const time = Number(value);
        return Number.isFinite(time) && time > 0 ? time : 0;
    }

    function parseTimestamps(value) {
        const result = new Map();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
        Object.entries(value).forEach(([key, timestamp]) => {
            const time = parseTimestamp(timestamp);
            if (key && time) result.set(key, time);
        });
        return result;
    }

    function parseOverrides(value) {
        const result = new Map();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
        Object.entries(value).forEach(([url, override]) => {
            if (override === 'allow' || override === 'block') {
                result.set(normalizeUrl(url), override);
            }
        });
        return result;
    }

    // GM_getValue/GM_setValue are synchronous in Tampermonkey/Violentmonkey but some
    // engines (e.g. AdGuard's userscript support) alias them to the async GM4 API, where
    // they return a Promise instead of the value. Routing every call through
    // Promise.resolve() handles both without needing to detect which one we're on—but it
    // does mean a plain object is never mistaken for stored state; a Promise passing
    // `typeof === 'object'` unchecked previously made every reload look empty.
    // Every value goes into storage as a JSON string and is decoded on the way out. The
    // GM4 API only promises to keep strings, numbers and booleans, and AdGuard for Android
    // holds to that: an object is handed straight back while the page stays open—so the
    // read-back after a save passes—but what reaches disk is not the object, and after a
    // reload the key reads as empty. That took the history and the sync switch with it
    // on every refresh. Values an older version stored as plain objects still decode.
    function decodeValue(raw, key) {
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (error) {
                // "[object Object]" is what such an engine kept of an object written by an
                // older version; there is nothing left to recover from it.
                console.warn(`[JVS] Stored value ${key} could not be decoded.`);
                return null;
            }
        }
        return raw && typeof raw === 'object' ? raw : null;
    }

    // The Userscripts app for Safari (iOS and macOS) offers only the dotted GM4 API—
    // GM.getValue, GM.setValue and the rest—and no GM_* functions at all, so calling
    // GM_setValue there threw a ReferenceError: nothing was ever stored, and saving the
    // sync settings or pasting a sync link reported that they could not be saved. Each
    // call is looked up here instead, preferring GM_* where both exist. GM_* functions are
    // often locals of the manager's wrapper rather than globals, so each is named directly
    // behind `typeof`, which does not throw when it is missing.
    const dottedGm = name => (typeof GM === 'object' && GM && typeof GM[name] === 'function'
        ? GM[name].bind(GM)
        : null);
    const gm = {
        getValue: typeof GM_getValue === 'function' ? GM_getValue : dottedGm('getValue'),
        setValue: typeof GM_setValue === 'function' ? GM_setValue : dottedGm('setValue'),
        listValues: typeof GM_listValues === 'function' ? GM_listValues : dottedGm('listValues'),
        deleteValue: typeof GM_deleteValue === 'function' ? GM_deleteValue : dottedGm('deleteValue'),
        addStyle: typeof GM_addStyle === 'function' ? GM_addStyle : dottedGm('addStyle'),
    };

    function gmCall(name, ...args) {
        if (!gm[name]) return Promise.reject(new Error(`GM ${name} is not available`));
        try {
            return Promise.resolve(gm[name](...args));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    async function loadValue(key) {
        return decodeValue(await gmCall('getValue', key, null), key);
    }

    function storeValue(key, value) {
        return gmCall('setValue', key, JSON.stringify(value));
    }

    async function readStoredState() {
        return combineSnapshot(await readStorageSnapshot());
    }

    // Whether any journal carries something the main document does not: the trace a
    // racing write leaves behind, and what the next page load puts back.
    function journalsAhead({ main, journals }) {
        const base = main || {};
        const ahead = (source, target) => Object.entries(source && typeof source === 'object' ? source : {})
            .some(([key, value]) => parseTimestamp(value) > parseTimestamp(target?.[key]));
        // A visit the main document has since removed, cleared or pruned is not missing.
        const visitAhead = visits => Object.entries(visits && typeof visits === 'object' ? visits : {})
            .some(([url, value]) => {
                const at = parseTimestamp(value);
                return at > parseTimestamp(base.visited?.[url])
                    && at > parseTimestamp(base.tombstones?.[tombstoneKey('v', url)])
                    && at > parseTimestamp(base.resetAt)
                    && at > parseTimestamp(base.prunedBefore);
            });
        return journals.some(({ doc }) => doc && (
            visitAhead(doc.visited)
            || ahead(doc.tombstones, base.tombstones)
            || ahead(doc.overrideTimes, base.overrideTimes)
            || parseTimestamp(doc.resetAt) > parseTimestamp(base.resetAt)
            || parseTimestamp(doc.settingsUpdatedAt) > (main ? documentSettingsAt(base) : 0)
        ));
    }

    async function readStorageSnapshot() {
        let main = null;
        try {
            main = await loadValue(STORAGE_KEY);
            storageAvailable = true;
        } catch (error) {
            storageAvailable = false;
            console.warn('[JVS] Isolated storage could not be read.', error);
            return { main: null, journals: [] };
        }
        return { main, journals: await readJournals() };
    }

    // ------------------------------------------------------------------
    // Per-page journals
    //
    // The history is one stored value, and every save is a read-merge-write of all of it.
    // Nothing makes that atomic across tabs: when a burst of Ctrl-clicks opens several
    // tabs at once, one tab can read the document, another save a visit, and the first
    // then write back a document without it. The merge cannot help, because the visit was
    // never in anything the first tab read—and the check after the write passes too,
    // because the write that clobbered it really did land.
    //
    // So each page also writes what it has recorded to a key of its own, which no other
    // page ever writes. Every read folds all the journals into the main document, so a
    // visit that a racing write dropped from the main document comes straight back on the
    // next read by any tab, and the next save puts it back for good. A journal is removed
    // by whichever page next saves once it has sat unchanged for JOURNAL_TTL_MS and that
    // page's own save—which merged it—is verified in place: by then no write that could
    // have been built without it can still be in flight.
    //
    // Engines without GM_listValues or GM_deleteValue cannot find or retire journals, so
    // they keep the single-document behaviour.
    // ------------------------------------------------------------------

    function journalingAvailable() {
        return Boolean(gm.listValues && gm.deleteValue);
    }

    async function readJournals() {
        if (!journalingAvailable()) return [];
        let keys;
        try {
            keys = await gmCall('listValues');
        } catch (error) {
            return [];
        }
        if (!Array.isArray(keys)) return [];
        // Read side by side: on an engine where each call is a round trip, one after
        // another would hold up every page load by the number of open journals.
        const journals = await Promise.all(keys
            .filter(key => typeof key === 'string' && key.startsWith(JOURNAL_KEY_PREFIX))
            .map(async key => {
                try {
                    return { key, doc: await loadValue(key) };
                } catch (error) {
                    // An unreadable journal is skipped for this read; it is retried on the next.
                    return null;
                }
            }));
        return journals.filter(Boolean);
    }

    // The settings timestamp a document carries, read the way mergeStoredState reads it.
    function documentSettingsAt(doc) {
        return Object.prototype.hasOwnProperty.call(doc, 'settingsUpdatedAt')
            ? parseTimestamp(doc.settingsUpdatedAt)
            : parseTimestamp(doc.updatedAt);
    }

    // When each setting in a document was last changed. A document from before the
    // per-field stamps says only when its settings as a whole last changed, which stands in
    // for every field; one that has never had its settings touched says zero, so none of its
    // defaults can outrank a choice made anywhere else.
    function documentSettingTimes(doc) {
        const times = {};
        if (!doc || typeof doc !== 'object') return times;
        const stamped = doc.settingTimes && typeof doc.settingTimes === 'object' && !Array.isArray(doc.settingTimes);
        const whole = documentSettingsAt(doc);
        Object.keys(DEFAULT_SETTINGS).forEach(field => {
            const at = stamped ? parseTimestamp(doc.settingTimes[field]) : whole;
            if (at) times[field] = at;
        });
        return times;
    }

    // Takes each field from whichever side changed it last. A tie between different values
    // is settled on the values themselves, so every device and the worker pick the same one.
    function mergeSettingFields(local, localTimes, remote, remoteTimes) {
        const result = { settings: { ...local }, times: { ...localTimes }, changed: false, adopted: false };
        Object.keys(DEFAULT_SETTINGS).forEach(field => {
            const remoteAt = parseTimestamp(remoteTimes[field]);
            const localAt = parseTimestamp(localTimes[field]);
            if (!remoteAt || remoteAt < localAt) return;
            const remoteValue = JSON.stringify(remote[field]);
            const localValue = JSON.stringify(local[field]);
            if (remoteAt === localAt && !(remoteValue > localValue)) return;
            if (remoteValue !== localValue) {
                result.settings[field] = remote[field];
                result.changed = true;
            }
            result.times[field] = remoteAt;
            result.adopted = true;
        });
        return result;
    }

    function newestSettingTime(times) {
        return Object.values(times).reduce((newest, at) => Math.max(newest, parseTimestamp(at)), 0);
    }

    // Folds the journals into a copy of the main document, keeping the newest of each
    // entry. Removals and horizons are only carried along, not applied: mergeStoredState
    // does that for whoever reads the result.
    function combineSnapshot({ main, journals }) {
        const docs = journals.map(journal => journal.doc).filter(Boolean);
        if (!docs.length) return main;
        const base = main || {};
        const combined = {
            ...base,
            updatedAt: parseTimestamp(base.updatedAt),
            settingsUpdatedAt: main ? documentSettingsAt(base) : 0,
            settingTimes: main ? documentSettingTimes(base) : {},
            resetAt: parseTimestamp(base.resetAt),
            prunedBefore: parseTimestamp(base.prunedBefore),
            visited: { ...(base.visited && typeof base.visited === 'object' ? base.visited : {}) },
            tombstones: { ...(base.tombstones && typeof base.tombstones === 'object' ? base.tombstones : {}) },
            overrides: { ...(base.overrides && typeof base.overrides === 'object' ? base.overrides : {}) },
            overrideTimes: { ...(base.overrideTimes && typeof base.overrideTimes === 'object' ? base.overrideTimes : {}) },
        };
        const newest = (target, source) => {
            if (!source || typeof source !== 'object') return;
            Object.entries(source).forEach(([key, value]) => {
                const at = parseTimestamp(value);
                if (at > parseTimestamp(target[key])) target[key] = at;
            });
        };
        docs.forEach(doc => {
            newest(combined.visited, doc.visited);
            newest(combined.tombstones, doc.tombstones);
            combined.resetAt = Math.max(combined.resetAt, parseTimestamp(doc.resetAt));
            combined.prunedBefore = Math.max(combined.prunedBefore, parseTimestamp(doc.prunedBefore));
            const docOverrides = doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {};
            const docOverrideTimes = doc.overrideTimes && typeof doc.overrideTimes === 'object' ? doc.overrideTimes : {};
            Object.entries(docOverrides).forEach(([url, value]) => {
                const at = parseTimestamp(docOverrideTimes[url]);
                if (at > parseTimestamp(combined.overrideTimes[url])) {
                    combined.overrides[url] = value;
                    combined.overrideTimes[url] = at;
                }
            });
            if (doc.settings && typeof doc.settings === 'object') {
                const merged = mergeSettingFields(
                    sanitizeSettings(combined.settings), combined.settingTimes,
                    sanitizeSettings(doc.settings), documentSettingTimes(doc),
                );
                if (merged.adopted) {
                    combined.settings = merged.settings;
                    combined.settingTimes = merged.times;
                    combined.settingsUpdatedAt = Math.max(combined.settingsUpdatedAt, newestSettingTime(merged.times));
                }
            }
        });
        return combined;
    }

    // Entries this page adopted with a timestamp from the past—a replayed click, rows
    // pulled from the worker, a restored backup—exist nowhere else in local storage yet,
    // so the journal has to reach back far enough to carry them.
    function lowerJournalSince(at) {
        const time = parseTimestamp(at);
        if (!time || time >= journalSince) return;
        journalSince = time;
        // A checkpoint taken before this entry arrived says nothing about it, and neither
        // does one from a save that was already under way.
        journalCheckpoints = [];
        journalLowerings += 1;
    }

    // Once a save that covered everything up to some moment has been verified in place for
    // longer than JOURNAL_TTL_MS, the journal no longer needs to reach back past it.
    function advanceJournalSince(now) {
        while (journalCheckpoints.length && now - journalCheckpoints[0].verifiedAt > JOURNAL_TTL_MS) {
            const { covers } = journalCheckpoints.shift();
            if (covers >= journalSince) journalSince = covers + 1;
        }
    }

    function serializeJournal(writtenAt) {
        const pick = source => {
            const result = {};
            for (const [key, at] of source) {
                if (at >= journalSince) result[key] = at;
            }
            return result;
        };
        const journalOverrides = {};
        const journalOverrideTimes = {};
        for (const [url, value] of overrides) {
            const at = overrideTimes.get(url) || 0;
            if (at >= journalSince) {
                journalOverrides[url] = value;
                journalOverrideTimes[url] = at;
            }
        }
        const journal = {
            version: STORAGE_VERSION,
            writtenAt,
            resetAt,
            prunedBefore,
            visited: pick(visited),
            tombstones: pick(tombstones),
            overrides: journalOverrides,
            overrideTimes: journalOverrideTimes,
        };
        // Settings are one small object, so they always ride along rather than being
        // tracked by where they came from; the newest copy wins when journals are folded.
        if (settingsUpdatedAt) {
            journal.settings = { ...settings };
            journal.settingsUpdatedAt = settingsUpdatedAt;
            journal.settingTimes = { ...settingTimes };
        }
        return journal;
    }

    async function writeJournal(writtenAt) {
        if (!journalingAvailable()) return;
        advanceJournalSince(writtenAt);
        const journal = serializeJournal(writtenAt);
        const carries = Object.keys(journal.visited).length
            || Object.keys(journal.tombstones).length
            || Object.keys(journal.overrides).length
            || resetAt >= journalSince
            || settingsUpdatedAt >= journalSince;
        if (carries) {
            await storeValue(journalKey, journal);
            journalWritten = true;
        } else if (journalWritten) {
            // Everything it held has been safely in the main document for a TTL.
            await gmCall('deleteValue', journalKey);
            journalWritten = false;
        }
    }

    // Called after this page's save is verified in place: that save merged every journal
    // in `snapshot`, so any of them that has sat unchanged past the TTL is no longer the
    // only copy of anything a racing write could still drop.
    async function retireJournals(snapshot, now) {
        if (!journalingAvailable()) return;
        for (const { key, doc } of snapshot.journals) {
            if (key === journalKey) continue;
            const writtenAt = parseTimestamp(doc?.writtenAt);
            if (doc && now - writtenAt <= JOURNAL_TTL_MS) continue;
            try {
                // Its page may have written to it since this save read it; if so it is
                // left for a later save to merge.
                const current = await loadValue(key);
                if (current && parseTimestamp(current.writtenAt) !== writtenAt) continue;
                await gmCall('deleteValue', key);
            } catch (error) {
                // Left in place; the next save tries again.
            }
        }
    }

    function serializeState() {
        return {
            version: STORAGE_VERSION,
            scriptVersion: SCRIPT_VERSION,
            updatedAt: Date.now(),
            settingsUpdatedAt,
            settingTimes: { ...settingTimes },
            resetAt,
            prunedBefore,
            settings: { ...settings },
            visited: Object.fromEntries(visited),
            overrides: Object.fromEntries(overrides),
            overrideTimes: Object.fromEntries(overrideTimes),
            tombstones: Object.fromEntries(tombstones),
        };
    }

    function tombstoneKey(kind, url) {
        return `${kind}|${url}`;
    }

    function tombstoneTime(kind, url) {
        return tombstones.get(tombstoneKey(kind, url)) || 0;
    }

    function forgetVisited(url, at = Date.now()) {
        visited.delete(url);
        tombstones.set(tombstoneKey('v', url), at);
    }

    function forgetOverride(url, at = Date.now()) {
        overrides.delete(url);
        overrideTimes.delete(url);
        tombstones.set(tombstoneKey('o', url), at);
    }

    // Engines without GM_addValueChangeListener—AdGuard is one—leave every tab holding the
    // snapshot it read at load time. Writing that snapshot back wholesale is what makes
    // history appear to vanish: the longest-open tab overwrites everything the other tabs
    // recorded in the meantime. So state is never replaced, only merged: newest timestamp
    // wins per URL, and removals are recorded as timestamps of their own (a per-URL
    // tombstone, or `resetAt` for a full clear) so that merging cannot resurrect them.
    function mergeStoredState(stored, { adoptSettings = false } = {}) {
        lastMergeAdopted = false;
        lastMergeBackdatedTo = 0;
        lastMergeOldest = 0;
        if (!stored || typeof stored !== 'object') return false;

        // An entry is "backdated" when it is stamped before this device's push horizon:
        // it was recorded somewhere this device had not looked—another tab, a replayed
        // click, a restored backup—so the horizon has already swept past it.
        const backdated = at => {
            if (at) lastMergeOldest = lastMergeOldest ? Math.min(lastMergeOldest, at) : at;
            if (!at || !pushHorizon() || at >= pushHorizon()) return;
            lastMergeBackdatedTo = lastMergeBackdatedTo ? Math.min(lastMergeBackdatedTo, at) : at;
        };

        const remoteVisited = parseVisited(stored.visited);
        const remoteOverrides = parseOverrides(stored.overrides);
        const remoteOverrideTimes = parseTimestamps(stored.overrideTimes);
        const remoteTombstones = parseTimestamps(stored.tombstones);
        const remoteReset = parseTimestamp(stored.resetAt);
        const remotePruned = parseTimestamp(stored.prunedBefore);
        const remoteUpdatedAt = parseTimestamp(stored.updatedAt);
        let changed = false;
        let adopted = false;

        if (remoteReset > resetAt) {
            resetAt = remoteReset;
            adopted = true;
            for (const [url, at] of visited) {
                if (at <= resetAt) {
                    visited.delete(url);
                    changed = true;
                }
            }
        }

        // Retention pruning drops entries without leaving a tombstone for each one, so the
        // cutoff itself travels with the document; without it every other device would hand
        // the expired entries straight back on the next merge.
        if (remotePruned > prunedBefore) {
            prunedBefore = remotePruned;
            adopted = true;
            for (const [url, at] of visited) {
                if (at <= prunedBefore) {
                    visited.delete(url);
                    changed = true;
                }
            }
        }

        for (const [key, at] of remoteTombstones) {
            if (at <= (tombstones.get(key) || 0)) continue;
            tombstones.set(key, at);
            adopted = true;
            backdated(at);
            const url = key.slice(2);
            if (key.startsWith('v|')) {
                if (visited.has(url) && visited.get(url) <= at) {
                    visited.delete(url);
                    changed = true;
                }
            } else if (key.startsWith('o|')) {
                if (overrides.has(url) && (overrideTimes.get(url) || 0) <= at) {
                    overrides.delete(url);
                    overrideTimes.delete(url);
                    changed = true;
                }
            }
        }

        for (const [url, at] of remoteVisited) {
            if (at <= resetAt || at <= prunedBefore || at <= tombstoneTime('v', url)) continue;
            if (at <= (visited.get(url) || 0)) continue;
            visited.set(url, at);
            backdated(at);
            changed = true;
        }

        for (const [url, value] of remoteOverrides) {
            const at = remoteOverrideTimes.get(url) || 0;
            // The worker settles a tie in a deletion's favour, so the same rule has to
            // apply here or the two sides stop converging on the same state.
            if (at <= tombstoneTime('o', url)) continue;
            if (at < (overrideTimes.get(url) || 0)) continue;
            if (overrides.get(url) === value) {
                // Same choice, newer stamp: recording it is what stops this device
                // offering the older one back on every sync from here on.
                if (at > (overrideTimes.get(url) || 0)) {
                    overrideTimes.set(url, at);
                    adopted = true;
                    backdated(at);
                }
                continue;
            }
            overrides.set(url, value);
            overrideTimes.set(url, at);
            backdated(at);
            changed = true;
        }

        // Only a document that actually carries settings may replace the local ones: an
        // empty remote store must not reset this device to the defaults.
        // Each field is taken on its own, so a device that changed only its tint cannot
        // hand back its copy of the keywords with it.
        if (adoptSettings && stored.settings && typeof stored.settings === 'object') {
            const merged = mergeSettingFields(
                settings, settingTimes,
                sanitizeSettings(stored.settings), documentSettingTimes(stored),
            );
            if (merged.adopted) {
                settings = merged.settings;
                settingTimes = merged.times;
                settingsUpdatedAt = Math.max(settingsUpdatedAt, newestSettingTime(settingTimes));
                adopted = true;
                if (merged.changed) changed = true;
            }
        }

        lastKnownUpdatedAt = Math.max(lastKnownUpdatedAt, remoteUpdatedAt);
        lastMergeAdopted = adopted || changed;
        return changed;
    }

    // Writes are queued so two read-merge-write cycles can never interleave and drop each
    // other's changes on engines where GM_setValue resolves asynchronously.
    function persistState() {
        writeQueue = writeQueue.then(() => writeStoredState(), () => writeStoredState());
        scheduleRemotePush();
        return writeQueue;
    }

    async function writeStoredState() {
        const startedAt = Date.now();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const lowerings = journalLowerings;
                const snapshot = await readStorageSnapshot();
                mergeStoredState(combineSnapshot(snapshot));
                notePushBacklog();
                pruneVisited();
                const payload = serializeState();
                // The journal goes first: if the page unloads between the two writes, the
                // journal is the copy that no other tab can overwrite.
                await writeJournal(payload.updatedAt);
                await storeValue(STORAGE_KEY, payload);
                // Read back rather than trusting the write: a value that never landed is
                // exactly the failure that used to go unnoticed until the history was gone.
                const verified = await loadValue(STORAGE_KEY);
                if (!verified || typeof verified !== 'object'
                    || parseTimestamp(verified.updatedAt) < payload.updatedAt) {
                    throw new Error('Stored state did not come back after writing.');
                }
                lastKnownUpdatedAt = payload.updatedAt;
                lastSavedAt = Date.now();
                lastSaveFailed = false;
                storageAvailable = true;
                clearPendingVisits(startedAt, verified);
                // Only a save still in place when read back vouches for what it merged.
                if (parseTimestamp(verified.updatedAt) === payload.updatedAt) {
                    if (lowerings === journalLowerings) journalCheckpoints.push({ verifiedAt: Date.now(), covers: payload.updatedAt });
                    await retireJournals(snapshot, Date.now());
                }
                scheduleCountUpdate();
                return true;
            } catch (error) {
                if (attempt === 0) {
                    await new Promise(resolve => window.setTimeout(resolve, 300));
                    continue;
                }
                storageAvailable = false;
                lastSaveFailed = true;
                console.warn('[JVS] Could not save settings or visited history.', error);
                showToast('Could not save—userscript storage rejected the write.', true);
                scheduleCountUpdate();
                return false;
            }
        }
        return false;
    }

    // A click starts a navigation, and on AdGuard the GM write that records it is
    // asynchronous, so the page can unload before the value ever reaches storage. Each
    // click is therefore also parked in sessionStorage—synchronous, and it survives the
    // navigation—and replayed on the next JavStore page load in that tab. sessionStorage is
    // readable by the site, so the note holds only URLs whose real write is still in
    // flight, it is dropped as soon as that write lands, and it can be switched off.
    function readPendingVisits() {
        try {
            const raw = sessionStorage.getItem(PENDING_VISITS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map(entry => ({ url: normalizeUrl(entry?.url), at: parseTimestamp(entry?.at) }))
                .filter(entry => entry.url && entry.at);
        } catch (error) {
            return [];
        }
    }

    function writePendingVisits(entries) {
        try {
            if (!entries.length) {
                sessionStorage.removeItem(PENDING_VISITS_KEY);
                return;
            }
            const payload = entries
                .slice(-MAX_PENDING_VISITS)
                .map(entry => ({ url: entry.url, at: entry.at }));
            sessionStorage.setItem(PENDING_VISITS_KEY, JSON.stringify(payload));
        } catch (error) {
            // Private windows and blocked site data are fine; the GM write still runs.
        }
    }

    function rememberPendingVisit(url, at) {
        if (!settings.fastNavigationSafety) return;
        const entries = readPendingVisits().filter(entry => entry.url !== url);
        entries.push({ url, at });
        writePendingVisits(entries);
    }

    // The note is the only copy of a click whose real write is still in flight, so it is
    // given up only once the document that came back from storage actually carries that
    // click. "The write returned a newer timestamp" is a weaker claim than it looks: the
    // entry can be dropped on the way—merged away by a tombstone, taken by a prune—and a
    // storage engine that answers a read from a cache it has not persisted reports
    // success for a value the next page load will not see. That last case is invisible
    // without this check, and it costs the visit outright when the tab does not navigate:
    // an ordinary click replays the note on the page it opens, but Cmd-clicking a tile
    // leaves the listing where it is, so a refresh is the next thing to read storage.
    // Entries the clear and retention horizons legitimately exclude are dropped rather
    // than replayed for the life of the tab.
    function clearPendingVisits(savedAt, stored) {
        // Both sides are already normalized, so the stored document is indexed directly
        // rather than reparsed—this runs on every save.
        const landed = stored && typeof stored.visited === 'object' && stored.visited
            ? stored.visited
            : {};
        let held = 0;
        const entries = readPendingVisits().filter(entry => {
            if (entry.at > savedAt) return true;
            if (entry.at <= resetAt || entry.at <= prunedBefore) return false;
            if (entry.at <= tombstoneTime('v', entry.url)) return false;
            if (parseTimestamp(landed[entry.url]) >= entry.at) return false;
            held += 1;
            return true;
        });
        if (held) {
            console.warn(`[JVS] ${held} visit(s) did not come back from storage after saving; keeping the replay note.`);
        }
        writePendingVisits(entries);
    }

    function replayPendingVisits() {
        const entries = readPendingVisits();
        if (!entries.length) return false;
        writePendingVisits([]);
        if (!settings.trackVisited) return false;
        let changed = false;
        entries.forEach(({ url, at }) => {
            if (at <= resetAt || at <= prunedBefore || at <= tombstoneTime('v', url)) return;
            if (at <= (visited.get(url) || 0)) return;
            visited.set(url, at);
            // The click happened before this page loaded, and possibly before the last
            // push: without pulling the horizon back it would never be offered upstream.
            lowerPushHorizon(at);
            lowerJournalSince(at);
            changed = true;
        });
        return changed;
    }

    // Landing on an item page is the visit itself, so it is recorded on its own evidence,
    // whatever happened to the click that was supposed to record it. That matters beyond a
    // lost write: "open link in new tab" from the browser's context menu reaches the page
    // as no click at all—the menu belongs to the browser, and only `contextmenu` (button 2)
    // is dispatched, which is equally what a "Copy link" or a dismissed menu looks like—so
    // this is the only honest place to catch it. Ctrl/Cmd+click and middle-click do
    // dispatch a click, which is why they alone used to be recorded.
    function recordCurrentPageVisit() {
        if (!settings.trackVisited) return false;
        if (!isItemPage()) return false;

        const url = normalizeUrl(location.href);
        const now = Date.now();
        if ((visited.get(url) || 0) >= now) return false;
        visited.set(url, now);
        tombstones.delete(tombstoneKey('v', url));
        return true;
    }

    // What has to be ruled out is a listing page, and a same-origin referrer cannot do it:
    // one listing links to the next, and a new tab may carry no referrer at all. Nor can
    // "the page has cards": an item page that carries a related-items strip has cards too,
    // and rejecting it is why a visit could go unrecorded even after the page had loaded.
    // So the URL decides first, then what the page says about itself, and a page carrying
    // cards is an item page when it also carries content those cards do not account for.
    function isItemPage() {
        if (location.pathname === '/' || NON_ITEM_PATH.test(location.pathname)) return false;
        if (LISTING_PAGE_PATH.test(location.pathname)) return false;
        if (document.querySelector(ITEM_PAGE_META)) return true;
        const cards = collectCards(document);
        if (!cards.length) return true;
        return hasContentOutsideCards(cards);
    }

    // An item page has content of its own—a title, a description, a file list—above
    // whatever related cards follow it, where a listing page is very nearly nothing but
    // its cards. A top-level heading that belongs to no card says so, and so does a body
    // of text next to them; a listing's own text is its heading and its pagination. Where
    // neither is decisive the page is not recorded, which costs a visit; recording a
    // listing URL instead costs a history entry no card will ever match.
    function hasContentOutsideCards(cards) {
        const root = document.querySelector('main') || document.body;
        if (!root) return false;
        const isOutside = node => !cards.some(card => card.contains(node));
        if ([...root.querySelectorAll('h1')].some(isOutside)) return true;
        const total = (root.textContent || '').trim().length;
        const outside = cards.reduce((rest, card) => rest - (card.textContent || '').trim().length, total);
        return outside >= MIN_ITEM_TEXT;
    }

    async function migrateLegacyHistory() {
        let raw;
        try {
            raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        } catch (error) {
            return;
        }
        if (!raw) return;

        try {
            const entries = JSON.parse(raw);
            if (Array.isArray(entries)) {
                const migratedAt = Date.now();
                entries.forEach(url => visited.set(normalizeUrl(url), migratedAt));
                pruneVisited();
                if (!(await persistState())) return;
            }
            localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch (error) {
            console.warn('[JVS] Legacy visited history could not be migrated.', error);
            try {
                localStorage.removeItem(LEGACY_STORAGE_KEY);
            } catch (removeError) {
                console.warn('[JVS] Legacy site-readable history could not be removed.', removeError);
            }
        }
    }

    function pruneVisited() {
        const now = Date.now();
        if (settings.retentionDays > 0) {
            const cutoff = now - settings.retentionDays * 86400000;
            for (const [url, timestamp] of visited) {
                if (timestamp < cutoff) visited.delete(url);
            }
            if (cutoff > prunedBefore) prunedBefore = cutoff;
        }

        // The cap is applied the same way here and in the worker—oldest first, URL breaking
        // a timestamp tie—so both sides of a sync keep the same 5,000 entries instead of
        // handing each other back the ones the other just dropped.
        if (visited.size > MAX_VISITED_ITEMS) {
            [...visited.entries()]
                .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))
                .slice(0, visited.size - MAX_VISITED_ITEMS)
                .forEach(([url]) => visited.delete(url));
        }

        // Tombstones only need to outlive the stale snapshots they protect against.
        for (const [key, at] of tombstones) {
            if (now - at > TOMBSTONE_TTL_MS) tombstones.delete(key);
        }
        if (tombstones.size > MAX_TOMBSTONES) {
            [...tombstones.entries()]
                .sort((a, b) => a[1] - b[1])
                .slice(0, tombstones.size - MAX_TOMBSTONES)
                .forEach(([key]) => tombstones.delete(key));
        }
        for (const url of overrideTimes.keys()) {
            if (!overrides.has(url)) overrideTimes.delete(url);
        }
        // An override with no timestamp is one the worker will refuse and this device will
        // never stop holding, so it is dated to the document it was found in.
        for (const url of overrides.keys()) {
            if (!overrideTimes.get(url)) overrideTimes.set(url, lastKnownUpdatedAt || now);
        }
    }

    // ------------------------------------------------------------------
    // Cloud sync
    //
    // The userscript manager's own storage is the working copy, but it is the thing that
    // keeps disappearing: AdGuard drops it on some upgrades, and it never leaves the
    // device. So the same history is also mirrored to a Cloudflare Worker that the user
    // owns, where a Durable Object holds it in SQLite.
    //
    // Devices exchange deltas. This one remembers the sequence number it last saw, asks for
    // everything recorded after it, and pushes only the entries it has touched since its
    // last successful push—so an ordinary page load costs a few hundred bytes rather than
    // the whole history. What comes back is folded in by the same merge that handles other
    // tabs: newest timestamp per URL wins, and tombstones and `resetAt`/`prunedBefore`
    // outrank a stale entry.
    // ------------------------------------------------------------------

    // Visited history is the payload, so it has to be encrypted in transit. Plain http is
    // accepted only against a loopback worker, which is what `wrangler dev` serves.
    // ------------------------------------------------------------------
    // Sync links
    //
    // AdGuard for Android clears a userscript's storage when it installs an update, and the
    // endpoint and token go with it. The only other place a userscript can write is the
    // site's own storage, which the site's scripts and ads can read, so the token is not kept
    // there. Instead the panel hands out one link carrying both, which you keep somewhere of
    // your own; opening it, or pasting it into the endpoint box, sets sync up again in one go.
    //
    // The link is a JavStore address with everything after `#`, which browsers never send to
    // a server. The script takes it off the address bar the moment it runs and asks before
    // using it: a link from anywhere else could otherwise point this device at a stranger's
    // worker and hand them the history.
    // ------------------------------------------------------------------

    const SYNC_LINK_PARAM = 'jvs-sync';

    function encodeSyncLink(config) {
        const json = JSON.stringify({ v: 1, e: config.endpoint, t: config.token, i: config.intervalMinutes });
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `https://javstore.net/#${SYNC_LINK_PARAM}=${encoded}`;
    }

    // Finds a sync link anywhere in the text, so a whole pasted message works as well as the
    // bare link. Returns null for anything that is not a usable one.
    function parseSyncLink(text) {
        const match = new RegExp(`${SYNC_LINK_PARAM}=([A-Za-z0-9_-]+)`).exec(String(text || ''));
        if (!match) return null;
        try {
            const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
            const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            const endpoint = String(parsed?.e || '').trim();
            const token = String(parsed?.t || '').trim();
            if (!isSyncEndpoint(endpoint) || !token) return null;
            return { endpoint, token, intervalMinutes: parsed.i };
        } catch (error) {
            return null;
        }
    }

    // Read and wiped before anything else on the page runs, so the token does not sit in
    // the address bar, the tab's history entry, or anywhere the site's own scripts look.
    let pendingSyncLink = null;
    try {
        if (location.hash.includes(`${SYNC_LINK_PARAM}=`)) {
            pendingSyncLink = parseSyncLink(location.hash) || false;
            history.replaceState(history.state, '', location.pathname + location.search);
        }
    } catch (error) {
        // Leaving the address alone is harmless; the link is simply not used.
    }

    async function applySyncLink(link) {
        const saved = await writeSyncConfig({
            ...syncConfig,
            enabled: true,
            endpoint: link.endpoint,
            token: link.token,
            intervalMinutes: link.intervalMinutes ?? syncConfig.intervalMinutes,
        });
        if (ui) fillSyncForm();
        restartSyncTimer();
        if (!saved) {
            showToast('Sync settings could not be saved.', true);
            return false;
        }
        showToast('Sync set up from the link. Syncing…');
        queueSync({ manual: true });
        return true;
    }

    function syncLinkHost(link) {
        try {
            return new URL(link.endpoint).host;
        } catch (error) {
            return link.endpoint;
        }
    }

    async function offerPendingSyncLink() {
        if (pendingSyncLink === null) return;
        const link = pendingSyncLink;
        pendingSyncLink = null;
        if (!link) {
            showToast('That sync link is not valid.', true);
            return;
        }
        if (syncConfigured() && syncConfig.endpoint === link.endpoint && syncConfig.token === link.token) {
            showToast('Sync is already set up with that link.');
            return;
        }
        if (!window.confirm(`Sync this device's history and settings with the worker at ${syncLinkHost(link)}?\n\nOnly continue if this is a sync link you made yourself.`)) return;
        await applySyncLink(link);
    }

    async function copySyncLink() {
        if (!syncConfigured() || !syncConfig.token) {
            showToast('Turn on cloud sync and save an endpoint and token first.', true);
            return;
        }
        const link = encodeSyncLink(syncConfig);
        try {
            await navigator.clipboard.writeText(link);
            showToast('Sync link copied. Keep it private: it carries your token.');
        } catch (error) {
            // No clipboard access (some engines, some browsers): show it to copy by hand.
            window.prompt('Copy this sync link and keep it private: it carries your token.', link);
        }
    }

    function isSyncEndpoint(value) {
        try {
            const url = new URL(value);
            if (url.protocol === 'https:') return true;
            return url.protocol === 'http:'
                && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
        } catch (error) {
            return false;
        }
    }

    function sanitizeSyncConfig(value = {}) {
        const candidate = value && typeof value === 'object' ? value : {};
        const endpoint = String(candidate.endpoint || '').trim().slice(0, 500);
        return {
            enabled: candidate.enabled === true,
            endpoint: isSyncEndpoint(endpoint) ? endpoint : '',
            token: String(candidate.token || '').trim().slice(0, 500),
            intervalMinutes: clamp(candidate.intervalMinutes, 1, 1440, DEFAULT_SYNC_CONFIG.intervalMinutes),
            cursor: clamp(candidate.cursor, 0, Number.MAX_SAFE_INTEGER, 0),
            pushedAt: parseTimestamp(candidate.pushedAt),
            remoteKey: String(candidate.remoteKey || '').slice(0, 500),
        };
    }

    function syncConfigured() {
        return syncConfig.enabled && Boolean(syncConfig.endpoint);
    }

    async function readSyncConfig() {
        try {
            return sanitizeSyncConfig(await loadValue(SYNC_CONFIG_KEY));
        } catch (error) {
            console.warn('[JVS] Cloud sync configuration could not be read.', error);
            return { ...DEFAULT_SYNC_CONFIG };
        }
    }

    async function writeSyncConfig(next) {
        syncConfig = sanitizeSyncConfig(next);
        try {
            await storeValue(SYNC_CONFIG_KEY, { ...syncConfig });
            return true;
        } catch (error) {
            console.warn('[JVS] Cloud sync configuration could not be saved.', error);
            return false;
        }
    }

    // GM_xmlhttpRequest is what reaches the worker from a page on another origin, and fetch
    // is the fallback: engines differ in how they handle `@connect`, and AdGuard in
    // particular can decline a cross-origin GM call outright, so a refusal there is retried
    // through fetch—which the worker's CORS headers allow. The token travels in a header
    // either way, never in the URL.
    function remoteFailure(message, { retryable = false } = {}) {
        const failure = new Error(message);
        failure.retryable = retryable;
        return failure;
    }

    // A refusal arrives with no status at all: the request never left the browser. Anything
    // carrying a status came from the worker and is reported as such.
    function describeTransportError(response) {
        const status = Number(response?.status) || 0;
        if (status) return `the worker answered ${status}`;
        const detail = String(response?.error || response?.statusText || '').trim();
        return detail
            ? `the worker could not be reached (${detail})`
            : 'the worker could not be reached';
    }

    function fetchRemote(url, headers, body) {
        if (typeof window.fetch !== 'function') {
            return Promise.reject(remoteFailure('this browser cannot reach the worker'));
        }
        return window.fetch(url, { method: 'POST', headers, body, credentials: 'omit', cache: 'no-store' })
            .then(
                async response => {
                    if (!response.ok) throw remoteFailure(`the worker answered ${response.status}`);
                    try {
                        return await response.json();
                    } catch (error) {
                        throw remoteFailure('the worker did not return JSON');
                    }
                },
                error => {
                    throw remoteFailure(`the worker could not be reached (${error?.message || 'blocked'})`);
                },
            );
    }

    function gmRemote(send, url, headers, body) {
        return new Promise((resolve, reject) => {
            send({
                method: 'POST',
                url,
                headers,
                data: body,
                timeout: REMOTE_TIMEOUT_MS,
                onload: response => {
                    const status = Number(response?.status) || 0;
                    if (status < 200 || status >= 300) {
                        reject(remoteFailure(`the worker answered ${status || 'nothing'}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (error) {
                        reject(remoteFailure('the worker did not return JSON'));
                    }
                },
                onerror: response => reject(remoteFailure(describeTransportError(response), { retryable: true })),
                ontimeout: () => reject(remoteFailure('the worker timed out')),
            });
        });
    }

    function requestRemote(payload) {
        const url = syncConfig.endpoint;
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${syncConfig.token}`,
        };
        const body = JSON.stringify(payload);
        const send = typeof GM_xmlhttpRequest === 'function'
            ? GM_xmlhttpRequest
            : (typeof GM === 'object' && GM && typeof GM.xmlHttpRequest === 'function'
                ? GM.xmlHttpRequest.bind(GM)
                : null);

        if (!send) return fetchRemote(url, headers, body);
        return gmRemote(send, url, headers, body).catch(error => {
            if (!error?.retryable) throw error;
            // Report the original refusal if fetch cannot get through either: that is the
            // path the userscript manager was supposed to take.
            return fetchRemote(url, headers, body).catch(() => {
                throw error;
            });
        });
    }

    // How far this device's pushes have got. Only meaningful against the worker it was
    // recorded from, so pointing the panel elsewhere reads it as zero.
    function pushHorizon() {
        return syncConfig.remoteKey === syncConfig.endpoint ? syncConfig.pushedAt : 0;
    }

    // The horizon is a wall-clock high-water mark: a sync declares "everything stamped
    // before now is upstream". That claim is only true of entries the syncing tab could
    // see, and an entry can reach this device stamped in the past—another tab recorded it
    // while this one was not looking, a click was replayed from the previous page, a
    // backup was restored. Such an entry is behind the horizon the moment it arrives and
    // would never be offered again, which is how a visit ends up on one device for good.
    // So the horizon is pulled back to it, and the next sync rescans from there. The cost
    // is re-offering a few entries the worker already has, which it discards on arrival.
    function lowerPushHorizon(at) {
        const time = parseTimestamp(at);
        if (!syncConfigured() || !time) return;
        const horizon = pushHorizon();
        if (!horizon || time >= horizon) return;
        syncConfig = { ...syncConfig, pushedAt: time };
        // Persisted through a read-modify-write that can only ever lower the stored
        // value: another tab may have moved it on legitimately in the meantime, and this
        // must not become a way to undo that.
        pendingHorizonWrite = pendingHorizonWrite.then(async () => {
            // A sync that ran in the meantime has pushed everything from here anyway, and
            // its horizon is then the authority: dragging it back would only cost a round
            // trip. Anything still holding this value has not been superseded.
            if (syncConfig.pushedAt !== time) return;
            const stored = await readSyncConfig();
            if (stored.remoteKey !== syncConfig.endpoint || !stored.pushedAt) return;
            if (stored.pushedAt <= time) return;
            await writeSyncConfig({ ...stored, pushedAt: time });
        }, () => {});
    }

    // Called after every merge of a document this device stores itself, so that whatever
    // the merge took on from another tab is pushed rather than silently swallowed. Remote
    // rows are excluded: they came from the worker, so re-offering them is pure waste.
    function notePushBacklog() {
        const at = lastMergeBackdatedTo;
        lastMergeBackdatedTo = 0;
        if (at && !applyingRemoteState) lowerPushHorizon(at);
    }

    // The entries this device has touched since its last successful push. Everything
    // recorded locally is stamped with the current time, so a single high-water mark is
    // enough to find them—and entries that arrived from the worker are always older than
    // it, so they are never sent straight back.
    function localChangesSince(since) {
        const changes = [];
        for (const [url, at] of visited) {
            if (at >= since) changes.push({ kind: 'v', key: url, at });
        }
        for (const [key, at] of tombstones) {
            if (at < since) continue;
            changes.push({ kind: key.startsWith('o|') ? 'o' : 'v', key: key.slice(2), at, deleted: 1 });
        }
        for (const [url, value] of overrides) {
            const at = overrideTimes.get(url) || 0;
            if (at >= since) changes.push({ kind: 'o', key: url, at, value });
        }
        return changes.sort((a, b) => a.at - b.at);
    }

    function localMeta() {
        return { resetAt, prunedBefore, settings: { ...settings }, settingsUpdatedAt, settingTimes: { ...settingTimes } };
    }

    // Rows come back in the delta shape; turning them into a document lets the merge that
    // already handles cross-tab state handle them too, rather than repeating its rules.
    function documentFromRows(rows, meta) {
        const visitedRows = {};
        const overrideRows = {};
        const overrideTimeRows = {};
        const tombstoneRows = {};
        (Array.isArray(rows) ? rows : []).forEach(row => {
            if (!row || typeof row !== 'object') return;
            const kind = row.kind === 'o' ? 'o' : 'v';
            const key = String(row.key || '');
            const at = parseTimestamp(row.at);
            if (!key || !at) return;
            if (row.deleted) {
                tombstoneRows[`${kind}|${key}`] = at;
            } else if (kind === 'v') {
                visitedRows[key] = at;
            } else if (row.value === 'allow' || row.value === 'block') {
                overrideRows[key] = row.value;
                overrideTimeRows[key] = at;
            }
        });
        const safeMeta = meta && typeof meta === 'object' ? meta : {};
        return {
            updatedAt: 0,
            resetAt: safeMeta.resetAt,
            prunedBefore: safeMeta.prunedBefore,
            settings: safeMeta.settings,
            settingsUpdatedAt: parseTimestamp(safeMeta.settingsUpdatedAt),
            ...(safeMeta.settingTimes && typeof safeMeta.settingTimes === 'object'
                ? { settingTimes: safeMeta.settingTimes }
                : {}),
            visited: visitedRows,
            overrides: overrideRows,
            overrideTimes: overrideTimeRows,
            tombstones: tombstoneRows,
        };
    }

    // Syncs are queued for the same reason writes are: two overlapping merge cycles would
    // each build on a snapshot the other has already moved past.
    function queueSync(options = {}) {
        if (!syncConfigured()) return Promise.resolve(false);
        remoteQueue = remoteQueue.then(() => runSync(options), () => runSync(options));
        return remoteQueue;
    }

    async function runSync({ manual = false } = {}) {
        if (!syncConfigured()) return false;
        lastRemoteAttemptAt = Date.now();
        remoteSyncRunning = true;
        scheduleCountUpdate();
        try {
            // Let any local write finish first so what gets pushed is the current state.
            await writeQueue.catch(() => false);

            // Read before the horizon is taken, so nothing recorded between the two can
            // fall into the gap.
            const horizon = Date.now();
            // Sibling tabs keep their own copy of the document and only write it to
            // storage; nothing tells this one that they have. Pushing from memory alone is
            // therefore pushing a stale document, and since the horizon afterwards claims
            // everything older than now is upstream, a visit another tab recorded is
            // stranded on this device for good. So the stored document is merged in first:
            // what this sync is about to declare pushed, it has now actually seen.
            applyStoredState(await readStoredState());
            pruneVisited();

            // The cursor and the high-water mark only mean anything against the worker they
            // were recorded from, so pointing the panel at a different one starts over.
            const sameRemote = syncConfig.remoteKey === syncConfig.endpoint;
            let cursor = sameRemote ? syncConfig.cursor : 0;
            const pushedAt = sameRemote ? syncConfig.pushedAt : 0;

            let outgoing = localChangesSince(pushedAt);
            let sent = 0;
            let changed = false;
            let absorbed = false;
            let legacy = false;

            for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
                const batch = outgoing.slice(0, REMOTE_PAGE_ROWS);
                const answer = await requestRemote({
                    client: SCRIPT_VERSION,
                    cursor,
                    limit: REMOTE_PAGE_ROWS,
                    meta: localMeta(),
                    changes: batch,
                });
                if (!answer || typeof answer !== 'object') {
                    throw new Error('the worker returned nothing');
                }
                remoteWorkerVersion = workerVersionFrom(answer);
                // A worker still running the document-only version answers with a whole
                // document and no cursor. Fall back to that exchange rather than silently
                // pulling from it without ever pushing.
                if (answer.state && typeof answer.state === 'object' && answer.cursor === undefined) {
                    legacy = true;
                    const echoed = await requestRemote({ client: SCRIPT_VERSION, state: serializeState() });
                    const document = echoed?.state && typeof echoed.state === 'object' ? echoed.state : answer.state;
                    if (applyStoredState(document)) changed = true;
                    if (lastMergeAdopted) absorbed = true;
                    lowerJournalSince(lastMergeOldest);
                    break;
                }

                outgoing = outgoing.slice(batch.length);
                sent += batch.length;
                cursor = Math.max(0, Number(answer.cursor) || 0);
                applyingRemoteState = true;
                if (applyStoredState(documentFromRows(answer.changes, answer.meta))) changed = true;
                // Pulled rows exist nowhere else on this device until they are saved.
                lowerJournalSince(lastMergeOldest);
                // A batch can carry nothing but protective metadata—a tombstone, a newer
                // `resetAt`, `prunedBefore` or `settingsUpdatedAt`—which removes nothing on
                // screen and so leaves `changed` false. It still has to be saved: the cursor
                // moves past it either way, and losing it lets a stale sibling tab merge an
                // already-deleted visit back in.
                if (lastMergeAdopted) absorbed = true;
                applyingRemoteState = false;
                if (!outgoing.length && !answer.more) break;
            }

            // What was pulled has to be in storage before the cursor is allowed past it.
            // The cursor is the durable record of what this device has already seen, so if
            // it advanced first and the state write were then interrupted by a navigation or
            // rejected outright, the next sync would ask only for rows after that cursor and
            // the merged ones would never be offered again.
            applyingRemoteState = true;
            const saved = (changed || absorbed) ? await persistState() : true;
            applyingRemoteState = false;
            if (!saved) throw new Error('the merged history could not be saved');

            // Only recorded after the exchange succeeded: a failed sync has to send the same
            // entries again rather than assume the worker took them.
            // The horizon may only cover what actually went up. `outgoing` is still
            // holding entries when the page budget ran out before they could be sent, and
            // moving the horizon past them would retire them unsent.
            const unsent = outgoing.reduce((oldest, change) => (
                oldest ? Math.min(oldest, change.at) : change.at
            ), 0);
            // And something backdated may have arrived after this sync chose what to send,
            // which pulled the horizon below where the exchange started. That entry was
            // never offered, so the sync cannot claim it.
            const arrived = syncConfig.pushedAt < pushedAt ? syncConfig.pushedAt : horizon;
            await writeSyncConfig({
                ...syncConfig,
                cursor: legacy ? 0 : cursor,
                pushedAt: legacy ? 0 : Math.min(horizon, unsent || horizon, arrived),
                remoteKey: legacy ? '' : syncConfig.endpoint,
            });

            lastRemoteSyncAt = Date.now();
            lastRemoteError = '';
            if (manual) {
                // Both directions, because a device that is quietly failing to push looks
                // exactly like one with nothing to push when only the pull is reported.
                const report = [];
                if (sent) report.push(`${sent} sent up`);
                if (changed) report.push('remote history merged in');
                showToast(report.length ? `Synced: ${report.join(', ')}.` : 'Synced. Nothing new either way.');
            }
            return changed;
        } catch (error) {
            lastRemoteError = String(error?.message || 'sync failed');
            console.warn('[JVS] Cloud sync failed.', error);
            if (manual) showToast(`Sync failed: ${lastRemoteError}`, true);
            return false;
        } finally {
            applyingRemoteState = false;
            remoteSyncRunning = false;
            if (deferredRemotePush) {
                deferredRemotePush = false;
                scheduleRemotePush();
            }
            scheduleCountUpdate();
        }
    }

    function scheduleRemotePush() {
        if (!syncConfigured()) return;
        if (applyingRemoteState) {
            deferredRemotePush = true;
            return;
        }
        window.clearTimeout(remotePushTimer);
        remotePushTimer = window.setTimeout(() => queueSync(), REMOTE_PUSH_DEBOUNCE_MS);
    }

    // Coming back to a tab is the moment its history is most likely to be stale, but it is
    // also easy to trigger dozens of times a minute, so it only syncs when the last attempt
    // is old enough.
    function syncOnFocus() {
        if (!syncConfigured()) return;
        if (Date.now() - lastRemoteAttemptAt < REMOTE_REFRESH_MIN_GAP_MS) return;
        queueSync();
    }

    function restartSyncTimer() {
        window.clearInterval(remotePollTimer);
        remotePollTimer = 0;
        if (!syncConfigured()) return;
        remotePollTimer = window.setInterval(() => queueSync(), syncConfig.intervalMinutes * 60000);
    }

    // Workers from 6.7.0 on name their version. Older ones are told apart by what they send:
    // 6.6.0 added per-setting stamps to the metadata, and before 6.3.0 there was no cursor.
    function workerVersionFrom(answer) {
        if (typeof answer?.worker === 'string' && answer.worker) return answer.worker.slice(0, 40);
        if (answer?.cursor === undefined) return 'older than 6.3.0';
        if (answer.meta && typeof answer.meta === 'object' && 'settingTimes' in answer.meta) return '6.6.0';
        return 'older than 6.6.0';
    }

    function compareVersions(left, right) {
        const parts = value => String(value).split('.').map(part => Number.parseInt(part, 10) || 0);
        const [a, b] = [parts(left), parts(right)];
        for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
            if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
        }
        return 0;
    }

    // A worker that only says it is "older than" some version is behind by definition.
    function workerBehindScript() {
        if (!syncConfigured() || !remoteWorkerVersion) return false;
        return !/^\d+(\.\d+)*$/.test(remoteWorkerVersion)
            || compareVersions(remoteWorkerVersion, SCRIPT_VERSION) < 0;
    }

    function describeWorkerVersion() {
        if (!syncConfigured()) return '';
        if (!remoteWorkerVersion) return 'Worker version: not known until the first sync on this page.';
        return `Worker version: ${remoteWorkerVersion}.`;
    }

    function describeWorkerBehind() {
        return `Your sync worker is ${remoteWorkerVersion}, behind this script (${SCRIPT_VERSION}). The worker redeploys from main through Cloudflare, so check its latest build in the Cloudflare dashboard.`;
    }

    // The worker deploys from the same commit the release is cut from, so a worker ahead of
    // this script means a newer script is out that the manager has not installed yet.
    function scriptBehindWorker() {
        return syncConfigured()
            && /^\d+(\.\d+)*$/.test(remoteWorkerVersion)
            && compareVersions(remoteWorkerVersion, SCRIPT_VERSION) > 0;
    }

    function describeSyncState() {
        if (!syncConfig.enabled) return 'cloud sync off';
        if (!syncConfig.endpoint) return 'cloud sync needs an endpoint';
        if (remoteSyncRunning) return 'syncing…';
        if (lastRemoteError) return `sync failed: ${lastRemoteError}`;
        if (!lastRemoteSyncAt) return 'not synced yet';
        const minutes = Math.floor((Date.now() - lastRemoteSyncAt) / 60000);
        if (minutes < 1) return 'synced just now';
        if (minutes < 60) return `synced ${minutes} min ago`;
        return `synced at ${new Date(lastRemoteSyncAt).toLocaleTimeString()}`;
    }

    settings = sanitizeSettings();
    visited = new Map();
    overrides = new Map();
    overrideTimes = new Map();
    tombstones = new Map();

    function setRootState() {
        const root = document.documentElement;
        if (!root) return;
        root.classList.add('jvs-active');
        root.classList.toggle('jvs-hide-sidebar', settings.hideSidebar);
        root.classList.toggle('jvs-overlays-lifted', settings.overlayLifted);
        root.style.setProperty('--jvs-tint-color', settings.tintColor);
        root.style.setProperty('--jvs-tint-opacity', settings.tintOpacity);
        root.style.setProperty('--jvs-blur', `${settings.blurAmount}px`);
        root.style.setProperty('--jvs-reveal-duration', `${settings.revealDuration}ms`);
        root.style.setProperty('--jvs-reveal-delay', `${settings.revealDelay}ms`);
        root.style.setProperty('--jvs-recover-duration', `${settings.recoverDuration}ms`);
        root.style.setProperty('--jvs-visited-opacity', settings.visitedOpacity);
    }

    const pageCss = `
        html.jvs-hide-sidebar aside.w-full.lg\\:w-80,
        html.jvs-hide-sidebar main aside {
            display: none !important;
        }

        html.jvs-hide-sidebar main.container > .flex,
        html.jvs-hide-sidebar main > .flex {
            flex-direction: column !important;
        }

        html.jvs-hide-sidebar main .flex-1.min-w-0 {
            width: 100% !important;
            max-width: 100% !important;
            margin-inline: auto !important;
        }

        html.jvs-active main.container {
            overflow-x: clip !important;
        }

        .jvs-card {
            position: relative !important;
        }

        .jvs-card .aspect-video {
            position: relative !important;
            overflow: hidden !important;
        }

        .jvs-card .aspect-video img {
            object-fit: cover !important;
            transition:
                transform 250ms ease,
                filter var(--jvs-recover-duration) ease,
                opacity 200ms ease !important;
        }

        .jvs-card:hover .aspect-video img,
        .jvs-card:focus-visible .aspect-video img {
            transform: scale(1.05) !important;
        }

        .jvs-card.jvs-visited .aspect-video img {
            opacity: var(--jvs-visited-opacity) !important;
            filter: grayscale(0.7) brightness(0.82) !important;
        }

        .jvs-card.jvs-visited::after {
            content: 'VISITED';
            position: absolute;
            top: 0.45rem;
            left: 0.45rem;
            z-index: 21;
            padding: 0.12rem 0.42rem;
            border-radius: 0.25rem;
            color: #fff;
            background: rgba(0, 0, 0, 0.72);
            font: 700 0.62rem/1.4 system-ui, sans-serif;
            letter-spacing: 0.05em;
            pointer-events: none;
        }

        .jvs-card-match .aspect-video::before {
            content: attr(data-jvs-match-label);
            position: absolute;
            right: 0.4rem;
            bottom: 0.4rem;
            z-index: 20;
            max-width: calc(100% - 0.8rem);
            padding: 0.12rem 0.38rem;
            border-radius: 0.25rem;
            color: #fff;
            background: rgba(0, 0, 0, 0.7);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font: 600 0.62rem/1.4 system-ui, sans-serif;
            pointer-events: none;
        }

        .jvs-card-match.jvs-mode-tint .aspect-video::after {
            content: '';
            position: absolute;
            inset: 0;
            z-index: 10;
            background: var(--jvs-tint-color);
            opacity: var(--jvs-tint-opacity);
            pointer-events: none;
            transition: opacity var(--jvs-recover-duration) ease;
        }

        .jvs-card-match.jvs-mode-tint:hover .aspect-video::after,
        .jvs-card-match.jvs-mode-tint:focus-visible .aspect-video::after,
        .jvs-card-match.jvs-mode-tint.jvs-card-revealed .aspect-video::after,
        html.jvs-overlays-lifted .jvs-card-match.jvs-mode-tint .aspect-video::after {
            opacity: 0;
            transition: opacity var(--jvs-reveal-duration) ease var(--jvs-reveal-delay);
        }

        .jvs-card-match.jvs-mode-blur .aspect-video img {
            filter: blur(var(--jvs-blur)) !important;
            transform: scale(1.08) !important;
        }

        .jvs-card-match.jvs-mode-blur:hover .aspect-video img,
        .jvs-card-match.jvs-mode-blur:focus-visible .aspect-video img,
        .jvs-card-match.jvs-mode-blur.jvs-card-revealed .aspect-video img,
        html.jvs-overlays-lifted .jvs-card-match.jvs-mode-blur .aspect-video img {
            filter: none !important;
            transform: scale(1.05) !important;
            transition:
                transform 250ms ease,
                filter var(--jvs-reveal-duration) ease var(--jvs-reveal-delay) !important;
        }

        .jvs-card-match.jvs-mode-hide:not(.jvs-card-revealed) {
            display: none !important;
        }

        html.jvs-overlays-lifted .jvs-card-match.jvs-mode-hide {
            display: block !important;
        }

        .jvs-card.jvs-filtered-out {
            display: none !important;
        }

        .jvs-card:focus-visible {
            outline: 3px solid #2563eb !important;
            outline-offset: 3px !important;
        }

        @media (prefers-reduced-motion: reduce) {
            .jvs-card .aspect-video img,
            .jvs-card .aspect-video::after {
                transition-duration: 0ms !important;
                transition-delay: 0ms !important;
            }

            .jvs-card:hover .aspect-video img,
            .jvs-card:focus-visible .aspect-video img {
                transform: none !important;
            }
        }
    `;

    function installPageCss() {
        try {
            if (!gm.addStyle) throw new Error('GM addStyle is not available');
            gm.addStyle(pageCss);
        } catch (error) {
            const style = document.createElement('style');
            style.textContent = pageCss;
            (document.head || document.documentElement).appendChild(style);
        }
    }

    setRootState();
    installPageCss();

    function isEditableTarget(target) {
        return target instanceof Element && (
            target.isContentEditable ||
            /^(input|textarea|select|button)$/i.test(target.tagName) ||
            Boolean(target.closest('[contenteditable="true"]'))
        );
    }

    function isCard(element) {
        return element instanceof HTMLAnchorElement
            && Boolean(element.querySelector('h3'))
            && Boolean(element.querySelector('.aspect-video img, [class*="aspect-"] img'));
    }

    function collectCards(root = document) {
        const cards = [];
        if (root instanceof Element && root.matches(CARD_SELECTOR) && isCard(root)) cards.push(root);
        if (root.querySelectorAll) {
            root.querySelectorAll(CARD_SELECTOR).forEach(card => {
                if (isCard(card)) cards.push(card);
            });
        }
        return cards;
    }

    function normalizeText(value) {
        return String(value || '').normalize('NFKC').toLocaleLowerCase();
    }

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function termMatches(text, rawTerm) {
        const term = normalizeText(rawTerm);
        if (!term) return false;
        if (settings.matchStrategy === 'substring') return text.includes(term);
        if (settings.matchStrategy === 'regex') {
            try {
                return new RegExp(rawTerm, 'iu').test(text);
            } catch (error) {
                return false;
            }
        }
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
    }

    function matchCard(card) {
        const url = normalizeUrl(card.href);
        const override = overrides.get(url);
        if (override === 'allow') return { matched: false, reason: 'Allowed manually' };
        if (override === 'block') return { matched: true, reason: 'Filtered manually' };

        const title = card.querySelector('h3')?.textContent || '';
        const searchable = normalizeText(title);
        const excluded = settings.excludedKeywords.find(term => termMatches(searchable, term));
        if (excluded) return { matched: false, reason: `Excluded: ${excluded}` };
        const keyword = settings.keywords.find(term => termMatches(searchable, term));
        return keyword
            ? { matched: true, reason: `Matched: ${keyword}` }
            : { matched: false, reason: '' };
    }

    function cardPassesFilter(card, matched) {
        const isVisited = settings.trackVisited && visited.has(normalizeUrl(card.href));
        if (settings.filter === 'visited') return isVisited;
        if (settings.filter === 'unvisited') return !isVisited;
        if (settings.filter === 'matched') return matched;
        return true;
    }

    function processCard(card) {
        card.classList.add('jvs-card');
        card.classList.remove('jvs-card-match', 'jvs-mode-tint', 'jvs-mode-blur', 'jvs-mode-hide', 'jvs-filtered-out');
        const thumbnail = card.querySelector('.aspect-video');

        const normalized = normalizeUrl(card.href);
        const isVisited = settings.trackVisited && visited.has(normalized);
        card.classList.toggle('jvs-visited', isVisited);

        const result = matchCard(card);
        if (result.matched) {
            card.classList.add('jvs-card-match', `jvs-mode-${settings.mode}`);
            if (thumbnail) thumbnail.dataset.jvsMatchLabel = result.reason;
        } else {
            if (thumbnail) delete thumbnail.dataset.jvsMatchLabel;
        }

        card.classList.toggle('jvs-filtered-out', !cardPassesFilter(card, result.matched));
        const descriptions = [];
        if (isVisited) descriptions.push('Visited');
        if (result.matched) descriptions.push(result.reason);
        if (overrides.has(normalized)) descriptions.push(`Override: ${overrides.get(normalized)}`);
        if (descriptions.length) card.setAttribute('aria-description', descriptions.join('. '));
        else card.removeAttribute('aria-description');
    }

    function processCards(root = document) {
        collectCards(root).forEach(processCard);
        scheduleCountUpdate();
    }

    function processAllCards() {
        processCards(document);
    }

    function markVisited(card, shouldVisit = true) {
        if (!settings.trackVisited || !card) return;
        const url = normalizeUrl(card.href);
        const now = Date.now();
        if (shouldVisit) {
            visited.set(url, now);
            tombstones.delete(tombstoneKey('v', url));
            rememberPendingVisit(url, now);
        } else {
            forgetVisited(url, now);
        }
        pruneVisited();
        processCard(card);
        persistState();
        scheduleCountUpdate();
    }

    function toggleCardReveal(card) {
        if (!card) return;
        const revealed = card.classList.toggle('jvs-card-revealed');
        showToast(`${revealed ? 'Revealed' : 'Protected'} this card.`);
    }

    function cycleCardOverride(card) {
        if (!card) return;
        const url = normalizeUrl(card.href);
        const current = overrides.get(url);
        const now = Date.now();
        if (!current || current === 'allow') {
            overrides.set(url, current ? 'block' : 'allow');
            overrideTimes.set(url, now);
            tombstones.delete(tombstoneKey('o', url));
        } else {
            forgetOverride(url, now);
        }
        persistState();
        processCard(card);
        updateSelectedCardUi();
        const next = overrides.get(url) || 'default matching';
        showToast(`Card override: ${next}.`);
    }

    function toggleOverlays() {
        settings.overlayLifted = !settings.overlayLifted;
        setRootState();
        persistState();
        updateUi();
        showToast(settings.overlayLifted ? 'All protected cards revealed.' : 'Protection restored.');
    }

    function setSelectedCard(card) {
        if (!isCard(card)) return;
        selectedCard = card;
        updateSelectedCardUi();
    }

    function onDocumentClick(event) {
        const card = event.target instanceof Element ? event.target.closest('a.jvs-card') : null;
        if (!card) return;
        if (suppressNextClick.has(card)) {
            suppressNextClick.delete(card);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.button === 0 && !event.defaultPrevented) markVisited(card, true);
    }

    function onAuxClick(event) {
        if (event.button !== 1) return;
        const card = event.target instanceof Element ? event.target.closest('a.jvs-card') : null;
        if (card && !event.defaultPrevented) markVisited(card, true);
    }

    function onPointerDown(event) {
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        const card = event.target instanceof Element ? event.target.closest('a.jvs-card-match') : null;
        if (!card) return;
        const timer = window.setTimeout(() => {
            longPressTimers.delete(event.pointerId);
            suppressNextClick.add(card);
            toggleCardReveal(card);
            if (navigator.vibrate) navigator.vibrate(25);
        }, 550);
        longPressTimers.set(event.pointerId, timer);
    }

    function cancelLongPress(event) {
        const timer = longPressTimers.get(event.pointerId);
        if (timer) window.clearTimeout(timer);
        longPressTimers.delete(event.pointerId);
    }

    function onKeyDown(event) {
        const origin = event.composedPath?.()[0] || event.target;
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(origin)) return;
        const key = event.key.toLowerCase();
        const focusedCard = origin instanceof Element ? origin.closest('a.jvs-card') : null;

        if (focusedCard && key === 'r') {
            event.preventDefault();
            event.stopPropagation();
            toggleCardReveal(focusedCard);
            return;
        }
        if (focusedCard && key === 'v') {
            event.preventDefault();
            event.stopPropagation();
            markVisited(focusedCard, !visited.has(normalizeUrl(focusedCard.href)));
            showToast(focusedCard.classList.contains('jvs-visited') ? 'Marked visited.' : 'Marked unvisited.');
            return;
        }
        if (focusedCard && key === 'o') {
            event.preventDefault();
            event.stopPropagation();
            cycleCardOverride(focusedCard);
            return;
        }
        if (key === settings.toggleKey) {
            event.preventDefault();
            event.stopPropagation();
            toggleOverlays();
        }
    }

    function observeDynamicContent() {
        observer?.disconnect();
        const root = document.body;
        if (!root) return;
        observer = new MutationObserver(mutations => {
            const roots = new Set();
            mutations.forEach(mutation => {
                if (mutation.type === 'characterData') {
                    const card = mutation.target.parentElement?.closest('a[href]');
                    if (card) roots.add(card);
                } else if (mutation.type === 'attributes') {
                    roots.add(mutation.target);
                } else {
                    mutation.addedNodes.forEach(node => {
                        if (node instanceof Element) roots.add(node);
                    });
                }
            });
            roots.forEach(processCards);
        });
        observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['href'],
        });
    }

    function scheduleCountUpdate() {
        if (countsQueued) return;
        countsQueued = true;
        requestAnimationFrame(() => {
            countsQueued = false;
            updateCounts();
        });
    }

    function getCounts() {
        const cards = collectCards(document);
        return {
            total: cards.length,
            matched: cards.filter(card => card.classList.contains('jvs-card-match')).length,
            visited: cards.filter(card => card.classList.contains('jvs-visited')).length,
            stored: visited.size,
        };
    }

    function describeSaveState() {
        if (lastSaveFailed) return 'last save failed';
        if (!lastSavedAt) return 'nothing saved yet this page';
        const minutes = Math.floor((Date.now() - lastSavedAt) / 60000);
        if (minutes < 1) return 'saved just now';
        if (minutes < 60) return `saved ${minutes} min ago`;
        return `saved at ${new Date(lastSavedAt).toLocaleTimeString()}`;
    }

    function updateCounts() {
        if (!ui) return;
        const counts = getCounts();
        const capped = counts.stored >= MAX_VISITED_ITEMS ? ' (cap reached—oldest are dropped)' : '';
        ui.summary.textContent = `${counts.matched} matched · ${counts.visited} visited`;
        ui.counts.textContent = `${counts.total} cards on this page · ${counts.stored} visited URLs stored${capped} · ${describeSaveState()} · ${describeSyncState()}`;
        const workerVersion = describeWorkerVersion();
        ui.workerVersion.textContent = workerVersion;
        ui.workerVersion.hidden = !workerVersion;
        const workerBehind = workerBehindScript();
        ui.redeployButton.hidden = !workerBehind;
        if (workerBehind) ui.redeployButton.title = describeWorkerBehind();
        const behind = scriptBehindWorker();
        ui.updateButton.hidden = !behind;
        ui.updateWarning.hidden = !behind;
        if (behind) {
            ui.updateVersions.textContent = `This script is ${SCRIPT_VERSION}, but your sync worker is already on ${remoteWorkerVersion}.`;
        }
    }

    function showToast(message, isError = false) {
        if (!ui) {
            console[isError ? 'warn' : 'info'](`[JVS] ${message}`);
            return;
        }
        ui.toast.textContent = message;
        ui.toast.classList.toggle('error', isError);
        ui.toast.classList.add('show');
        window.clearTimeout(ui.toastTimer);
        ui.toastTimer = window.setTimeout(() => ui?.toast.classList.remove('show'), Math.max(2800, message.length * 60));
    }

    function splitTerms(value) {
        return [...new Set(value.split(/[\n,]+/).map(term => term.trim()).filter(Boolean))];
    }

    function readSettingsForm() {
        return sanitizeSettings({
            ...settings,
            keywords: splitTerms(ui.form.elements.keywords.value),
            excludedKeywords: splitTerms(ui.form.elements.excludedKeywords.value),
            matchStrategy: ui.form.elements.matchStrategy.value,
            mode: ui.form.elements.mode.value,
            tintColor: ui.form.elements.tintColor.value,
            tintOpacity: ui.form.elements.tintOpacity.value,
            blurAmount: ui.form.elements.blurAmount.value,
            revealDuration: ui.form.elements.revealDuration.value,
            revealDelay: ui.form.elements.revealDelay.value,
            recoverDuration: ui.form.elements.recoverDuration.value,
            toggleKey: ui.form.elements.toggleKey.value,
            trackVisited: ui.form.elements.trackVisited.checked,
            fastNavigationSafety: ui.form.elements.fastNavigationSafety.checked,
            visitedOpacity: ui.form.elements.visitedOpacity.value,
            retentionDays: ui.form.elements.retentionDays.value,
            hideSidebar: ui.form.elements.hideSidebar.checked,
            filter: ui.form.elements.filter.value,
        });
    }

    function fillSettingsForm() {
        if (!ui) return;
        const elements = ui.form.elements;
        elements.keywords.value = settings.keywords.join(', ');
        elements.excludedKeywords.value = settings.excludedKeywords.join(', ');
        elements.matchStrategy.value = settings.matchStrategy;
        elements.mode.value = settings.mode;
        elements.tintColor.value = settings.tintColor;
        elements.tintOpacity.value = settings.tintOpacity;
        elements.blurAmount.value = settings.blurAmount;
        elements.revealDuration.value = settings.revealDuration;
        elements.revealDelay.value = settings.revealDelay;
        elements.recoverDuration.value = settings.recoverDuration;
        elements.toggleKey.value = settings.toggleKey;
        elements.trackVisited.checked = settings.trackVisited;
        elements.fastNavigationSafety.checked = settings.fastNavigationSafety;
        elements.visitedOpacity.value = settings.visitedOpacity;
        elements.retentionDays.value = settings.retentionDays;
        elements.hideSidebar.checked = settings.hideSidebar;
        elements.filter.value = settings.filter;
    }

    function readSyncForm() {
        const elements = ui.syncForm.elements;
        const typed = String(elements.syncToken.value || '').trim();
        return sanitizeSyncConfig({
            // Saving the panel is not a reason to forget where this device is up to; the
            // cursor is discarded only when it turns out to belong to a different worker.
            cursor: syncConfig.cursor,
            pushedAt: syncConfig.pushedAt,
            remoteKey: syncConfig.remoteKey,
            enabled: elements.syncEnabled.checked,
            endpoint: elements.syncEndpoint.value,
            // An empty box means "keep the token already stored"—it is deliberately never
            // filled back in, so it cannot be read as a request to clear it.
            token: typed || syncConfig.token,
            intervalMinutes: elements.syncIntervalMinutes.value,
        });
    }

    function fillSyncForm() {
        if (!ui) return;
        const elements = ui.syncForm.elements;
        elements.syncEnabled.checked = syncConfig.enabled;
        elements.syncEndpoint.value = syncConfig.endpoint;
        // The panel lives in an open shadow root, which the site's own scripts can reach, so
        // the token is never parked in the DOM: the box only reports whether one is stored.
        elements.syncToken.value = '';
        elements.syncToken.placeholder = syncConfig.token
            ? 'Stored — type to replace'
            : 'Paste the token from your worker';
        elements.syncIntervalMinutes.value = syncConfig.intervalMinutes;
    }

    // Only the fields that actually changed are stamped, unless every one is being set on
    // purpose (restoring the defaults), so saving the panel after changing one thing does
    // not claim all the others as this device's newest choice.
    function stampSettings(next, { all = false } = {}) {
        const now = Math.max(Date.now(), settingsUpdatedAt + 1);
        Object.keys(DEFAULT_SETTINGS).forEach(field => {
            if (all || JSON.stringify(next[field]) !== JSON.stringify(settings[field])) settingTimes[field] = now;
        });
        settings = next;
        settingsUpdatedAt = Math.max(settingsUpdatedAt, newestSettingTime(settingTimes));
    }

    function applySettings(nextSettings, message = 'Settings applied.', { all = false } = {}) {
        stampSettings(sanitizeSettings(nextSettings), { all });
        pruneVisited();
        setRootState();
        processAllCards();
        persistState();
        fillSettingsForm();
        updateUi();
        showToast(message);
    }

    function updateSelectedCardUi() {
        if (!ui) return;
        const valid = selectedCard?.isConnected && isCard(selectedCard);
        ui.selectedTitle.textContent = valid
            ? (selectedCard.querySelector('h3')?.textContent || 'Selected card').trim()
            : 'Hover or focus a card to select it.';
        ui.selectedActions.forEach(button => { button.disabled = !valid; });
        if (valid) {
            const override = overrides.get(normalizeUrl(selectedCard.href)) || 'default';
            ui.overrideButton.textContent = `Override: ${override}`;
        } else {
            ui.overrideButton.textContent = 'Override: default';
        }
    }

    function updateUi() {
        if (!ui) return;
        ui.liftButton.textContent = settings.overlayLifted ? 'Protect' : 'Reveal all';
        ui.liftButton.setAttribute('aria-pressed', String(settings.overlayLifted));
        ui.storageWarning.hidden = storageAvailable;
        updateCounts();
        updateSelectedCardUi();
    }

    function exportState() {
        const payload = JSON.stringify(serializeState(), null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `javstore-cleanup-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('Settings and visited history exported.');
    }

    async function importState(file) {
        try {
            const raw = JSON.parse(await file.text());
            // A backup taken straight from the worker (`GET /state`) is wrapped in `state`.
            const parsed = raw && typeof raw === 'object' && raw.state && typeof raw.state === 'object'
                ? raw.state
                : raw;
            if (!parsed || typeof parsed !== 'object') throw new Error('Invalid backup');
            if (!window.confirm('Replace current settings, history, and per-card overrides with this backup?')) return;
            const now = Date.now();
            const restored = parseVisited(parsed.visited);
            const restoredOverrides = parseOverrides(parsed.overrides);
            const restoredOverrideTimes = parseTimestamps(parsed.overrideTimes);

            // A backup is by definition older than the moment it is restored, so clearing
            // the way for it with a `resetAt` of now would delete the very entries it
            // carries—on every other device and on the worker, which both drop anything
            // stamped at or before the reset. What the restore actually drops is recorded
            // entry by entry instead, which travels without taking the restored history
            // with it and leaves its timestamps intact.
            for (const url of visited.keys()) {
                if (!restored.has(url)) tombstones.set(tombstoneKey('v', url), now);
            }
            for (const url of overrides.keys()) {
                if (!restoredOverrides.has(url)) tombstones.set(tombstoneKey('o', url), now);
            }
            // A restored entry outranks any removal this device was still carrying for it.
            for (const url of restored.keys()) tombstones.delete(tombstoneKey('v', url));
            for (const url of restoredOverrides.keys()) tombstones.delete(tombstoneKey('o', url));

            stampSettings(sanitizeSettings(parsed.settings), { all: true });
            visited = restored;
            overrides = restoredOverrides;
            overrideTimes = restoredOverrideTimes;
            // The backup's own horizons are adopted if they are ahead of this device's;
            // neither is ever moved back, so a clear that happened after the backup was
            // taken still stands, and what it covers cannot be restored.
            resetAt = Math.max(resetAt, parseTimestamp(parsed.resetAt));
            prunedBefore = Math.max(prunedBefore, parseTimestamp(parsed.prunedBefore));
            let skipped = 0;
            for (const [url, at] of visited) {
                if (at <= resetAt || at <= prunedBefore) {
                    visited.delete(url);
                    skipped += 1;
                }
            }
            pruneVisited();
            // Everything restored is stamped in the past, so without this the push horizon
            // would already be sitting in front of it and none of it would ever go up.
            const oldest = [...visited.values(), ...overrideTimes.values()]
                .reduce((least, at) => (least ? Math.min(least, at) : at), 0);
            lowerPushHorizon(oldest);
            lowerJournalSince(oldest);
            persistState();
            setRootState();
            processAllCards();
            fillSettingsForm();
            updateUi();
            showToast(skipped
                ? `Backup imported. ${skipped} entries predate a history clear and were skipped.`
                : 'Backup imported.');
        } catch (error) {
            showToast('Import failed: the selected file is not a valid backup.', true);
        }
    }

    function createUi() {
        const host = document.createElement('div');
        host.id = 'jvs-controls-host';
        host.setAttribute('data-jvs-ui', '');
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                *, *::before, *::after { box-sizing: border-box; }
                .dock {
                    position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
                    display: flex; gap: 8px; align-items: center;
                    color: #f8fafc; font: 500 13px/1.4 system-ui, -apple-system, sans-serif;
                }
                button, input, select, textarea { font: inherit; }
                button { cursor: pointer; }
                .pill, .icon-button {
                    min-height: 40px; border: 1px solid rgba(255,255,255,.2); border-radius: 999px;
                    color: #fff; background: #111827; box-shadow: 0 8px 24px rgba(0,0,0,.28);
                }
                .pill { padding: 8px 14px; }
                .icon-button { width: 40px; padding: 0; font-size: 18px; }
                button:hover { background: #1f2937; }
                button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
                    outline: 3px solid #60a5fa; outline-offset: 2px;
                }
                .panel {
                    position: fixed; right: 16px; bottom: 68px; z-index: 2147483646;
                    width: min(440px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 92px));
                    overflow: auto; padding: 18px; border: 1px solid #374151; border-radius: 16px;
                    color: #e5e7eb; background: #111827; box-shadow: 0 18px 50px rgba(0,0,0,.45);
                    font: 500 13px/1.45 system-ui, -apple-system, sans-serif;
                }
                .panel[hidden] { display: none; }
                .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
                h2 { margin: 0; color: #fff; font-size: 18px; }
                h3 { margin: 18px 0 8px; color: #fff; font-size: 14px; }
                p { margin: 6px 0; }
                .muted { color: #9ca3af; font-size: 12px; }
                .warning { padding: 8px; border-radius: 8px; color: #fecaca; background: #7f1d1d; }
                .warning a { color: #fff; }
                .pill.update, .pill.redeploy { border-color: #fca5a5; background: #991b1b; }
                .pill.update:hover, .pill.redeploy:hover { background: #7f1d1d; }
                .pill[hidden], .warning[hidden] { display: none; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
                .full { grid-column: 1 / -1; }
                label { display: grid; gap: 5px; color: #d1d5db; }
                label.check { display: flex; align-items: center; gap: 8px; }
                input[type="text"], input[type="number"], select, textarea {
                    width: 100%; min-height: 36px; padding: 7px 9px; border: 1px solid #4b5563;
                    border-radius: 8px; color: #fff; background: #1f2937;
                }
                textarea { min-height: 58px; resize: vertical; }
                input[type="color"] { width: 100%; height: 36px; padding: 2px; border: 1px solid #4b5563; border-radius: 8px; background: #1f2937; }
                input[type="range"] { width: 100%; }
                .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
                .actions button {
                    min-height: 34px; padding: 6px 10px; border: 1px solid #4b5563; border-radius: 8px;
                    color: #fff; background: #1f2937;
                }
                .actions .primary { border-color: #2563eb; background: #2563eb; }
                .actions .danger { border-color: #991b1b; background: #7f1d1d; }
                .selected-title { max-height: 42px; overflow: hidden; color: #dbeafe; }
                .toast {
                    position: fixed; right: 16px; bottom: 68px; z-index: 2147483647;
                    max-width: min(360px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 10px;
                    color: #fff; background: #166534; box-shadow: 0 8px 30px rgba(0,0,0,.35);
                    opacity: 0; transform: translateY(8px); pointer-events: none;
                    transition: opacity .16s ease, transform .16s ease;
                }
                .toast.error { background: #991b1b; }
                .toast.show { opacity: 1; transform: translateY(0); }
                @media (max-width: 520px) {
                    .dock { right: 10px; bottom: 10px; }
                    .panel { right: 10px; bottom: 62px; width: calc(100vw - 20px); max-height: calc(100vh - 76px); }
                    .grid { grid-template-columns: 1fr; }
                    .full { grid-column: auto; }
                }
                @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
            </style>
            <div class="dock" aria-label="JavStore cleanup controls">
                <button class="pill update" type="button" hidden>⚠ Update script</button>
                <button class="pill redeploy" type="button" hidden>⚠ Redeploy worker</button>
                <button class="pill lift" type="button">Reveal all</button>
                <button class="pill summary" type="button" aria-expanded="false">JavStore controls</button>
            </div>
            <section class="panel" hidden aria-label="JavStore cleanup settings">
                <div class="panel-header">
                    <div><h2>JavStore Cleanup</h2><p class="muted">Version ${SCRIPT_VERSION}</p></div>
                    <button class="icon-button close" type="button" aria-label="Close settings">×</button>
                </div>
                <p class="warning update-warning" hidden><span class="update-versions"></span> Settings or history the worker now handles may not sync correctly until you update. <a class="install" href="${INSTALL_URL}" target="_blank" rel="noopener noreferrer">Install the latest version</a>, or run your userscript manager's update check.</p>
                <p class="warning storage-warning" hidden>Private storage is unavailable. Changes will work for this page but cannot be saved.</p>
                <p class="counts muted"></p>
                <form class="settings-form">
                    <h3>Filtering</h3>
                    <div class="grid">
                        <label>Mode
                            <select name="mode"><option value="tint">Tint</option><option value="blur">Blur</option><option value="hide">Hide</option></select>
                        </label>
                        <label>Show cards
                            <select name="filter"><option value="all">All</option><option value="unvisited">Unvisited</option><option value="visited">Visited</option><option value="matched">Matched</option></select>
                        </label>
                        <label>Matching
                            <select name="matchStrategy"><option value="word">Whole word/phrase</option><option value="substring">Substring</option><option value="regex">Regular expression</option></select>
                        </label>
                        <label>Tint color <input name="tintColor" type="color"></label>
                        <label class="full">Match terms <textarea name="keywords" spellcheck="false"></textarea></label>
                        <label class="full">Excluded terms <textarea name="excludedKeywords" spellcheck="false" placeholder="Never filter titles containing these terms"></textarea></label>
                        <label>Tint opacity <input name="tintOpacity" type="range" min="0.1" max="0.9" step="0.05"></label>
                        <label>Blur strength <input name="blurAmount" type="range" min="2" max="40" step="1"></label>
                    </div>
                    <h3>Behavior</h3>
                    <div class="grid">
                        <label class="check"><input name="hideSidebar" type="checkbox"> Hide sidebar</label>
                        <label class="check"><input name="trackVisited" type="checkbox"> Track visited cards</label>
                        <label class="check" title="Keeps a short-lived, per-tab note of clicks the userscript manager has not stored yet, so a visit is not lost when the page unloads mid-save."><input name="fastNavigationSafety" type="checkbox"> Fast-navigation safety net</label>
                        <label>Reveal delay (ms) <input name="revealDelay" type="number" min="0" max="5000" step="100"></label>
                        <label>Reveal duration (ms) <input name="revealDuration" type="number" min="0" max="5000" step="100"></label>
                        <label>Recovery duration (ms) <input name="recoverDuration" type="number" min="0" max="2000" step="50"></label>
                        <label>Global shortcut <input name="toggleKey" type="text" maxlength="1"></label>
                        <label>Visited thumbnail opacity <input name="visitedOpacity" type="range" min="0.4" max="1" step="0.05"></label>
                        <label>History retention (days) <input name="retentionDays" type="number" min="0" max="3650" step="1" title="Use 0 to keep history until manually cleared"></label>
                    </div>
                    <div class="actions"><button class="primary apply" type="submit">Apply settings</button><button class="reset" type="button">Reset settings</button></div>
                </form>
                <h3>Selected card</h3>
                <p class="selected-title">Hover or focus a card to select it.</p>
                <div class="actions selected-actions">
                    <button class="card-reveal" type="button">Reveal/protect</button>
                    <button class="card-visited" type="button">Mark visited/unvisited</button>
                    <button class="card-override" type="button">Override: default</button>
                </div>
                <p class="muted">Keyboard: focus a card and press R to reveal, V to mark visited, or O to cycle its override. On touch, long-press a matched card. Press the global shortcut outside form fields to reveal/protect all.</p>
                <h3>Cloud sync</h3>
                <p class="muted">Mirror settings and visited history to a Cloudflare Worker you own, so history survives a userscript-manager reinstall and follows you between devices. The <code>worker/</code> folder in the repository has the deploy steps. The endpoint and token stay on this device: they are never written into the synced document or an exported backup.</p>
                <form class="sync-form">
                    <div class="grid">
                        <label class="check full"><input name="syncEnabled" type="checkbox"> Sync to my Cloudflare Worker</label>
                        <label class="full">Worker endpoint or sync link <input name="syncEndpoint" type="url" spellcheck="false" autocomplete="off" placeholder="https://javstore-sync.example.workers.dev/state"></label>
                        <label class="full">Access token <input name="syncToken" type="password" spellcheck="false" autocomplete="off"></label>
                        <p class="muted full">The token is stored by the userscript manager, not kept in the page. Leave the box empty to keep the token already saved.</p>
                        <label>Sync every (minutes) <input name="syncIntervalMinutes" type="number" min="1" max="1440" step="1"></label>
                    </div>
                    <div class="actions"><button class="primary save-sync" type="submit">Save sync settings</button><button class="sync-now" type="button">Sync now</button><button class="copy-sync-link" type="button">Copy sync link</button></div>
                    <p class="muted">A sync link carries the endpoint and token together. Keep it somewhere private, such as a password manager. If an update to your userscript manager wipes these settings, open the link on JavStore or paste it into the endpoint box and save.</p>
                </form>
                <p class="muted worker-version" hidden></p>
                <h3>Data</h3>
                <div class="actions">
                    <button class="export" type="button">Export backup</button>
                    <button class="import" type="button">Import backup</button>
                    <button class="danger clear" type="button">Clear visited history</button>
                    <input class="import-file" type="file" accept="application/json,.json" hidden>
                </div>
            </section>
            <div class="toast" role="status" aria-live="polite"></div>
        `;

        const panel = shadow.querySelector('.panel');
        const summary = shadow.querySelector('.summary');
        const liftButton = shadow.querySelector('.lift');
        const form = shadow.querySelector('form.settings-form');
        const syncForm = shadow.querySelector('form.sync-form');
        const selectedActions = [...shadow.querySelectorAll('.selected-actions button')];
        ui = {
            host, shadow, panel, summary, liftButton, form, syncForm, selectedActions,
            counts: shadow.querySelector('.counts'),
            workerVersion: shadow.querySelector('.worker-version'),
            storageWarning: shadow.querySelector('.storage-warning'),
            updateButton: shadow.querySelector('.update'),
            redeployButton: shadow.querySelector('.redeploy'),
            updateWarning: shadow.querySelector('.update-warning'),
            updateVersions: shadow.querySelector('.update-versions'),
            selectedTitle: shadow.querySelector('.selected-title'),
            overrideButton: shadow.querySelector('.card-override'),
            toast: shadow.querySelector('.toast'),
            toastTimer: 0,
        };

        function setPanelOpen(open) {
            panel.hidden = !open;
            summary.setAttribute('aria-expanded', String(open));
            if (open) {
                fillSettingsForm();
                fillSyncForm();
                updateUi();
                shadow.querySelector('.close').focus();
            }
        }

        summary.addEventListener('click', () => setPanelOpen(panel.hidden));
        shadow.querySelector('.close').addEventListener('click', () => setPanelOpen(false));
        liftButton.addEventListener('click', toggleOverlays);
        shadow.querySelector('.update').addEventListener('click', () => setPanelOpen(true));
        shadow.querySelector('.redeploy').addEventListener('click', () => showToast(describeWorkerBehind(), true));
        form.addEventListener('submit', event => {
            event.preventDefault();
            applySettings(readSettingsForm());
        });
        shadow.querySelector('.reset').addEventListener('click', () => {
            applySettings({ ...DEFAULT_SETTINGS }, 'Default settings restored.', { all: true });
        });
        shadow.querySelector('.card-reveal').addEventListener('click', () => toggleCardReveal(selectedCard));
        shadow.querySelector('.card-visited').addEventListener('click', () => {
            if (!selectedCard) return;
            markVisited(selectedCard, !visited.has(normalizeUrl(selectedCard.href)));
            showToast(selectedCard.classList.contains('jvs-visited') ? 'Marked visited.' : 'Marked unvisited.');
        });
        shadow.querySelector('.card-override').addEventListener('click', () => cycleCardOverride(selectedCard));
        shadow.querySelector('.export').addEventListener('click', exportState);
        const importFile = shadow.querySelector('.import-file');
        shadow.querySelector('.import').addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', () => {
            if (importFile.files?.[0]) importState(importFile.files[0]);
            importFile.value = '';
        });
        shadow.querySelector('.clear').addEventListener('click', () => {
            if (!window.confirm(`Clear all ${visited.size} visited URLs? This cannot be undone unless you exported a backup.`)) return;
            resetAt = Date.now();
            visited.clear();
            for (const key of tombstones.keys()) {
                if (key.startsWith('v|')) tombstones.delete(key);
            }
            persistState();
            processAllCards();
            showToast('Visited history cleared.');
        });
        syncForm.addEventListener('submit', async event => {
            event.preventDefault();
            // A sync link pasted into the endpoint box fills in everything it carries. Pasting
            // it is itself the request, so there is nothing further to confirm.
            const pasted = parseSyncLink(syncForm.elements.syncEndpoint.value);
            if (pasted) {
                await applySyncLink(pasted);
                return;
            }
            const next = readSyncForm();
            if (next.enabled && !next.endpoint) {
                showToast('Sync needs an https worker URL.', true);
                return;
            }
            if (next.enabled && !next.token) {
                showToast('Sync needs the access token from your worker.', true);
                return;
            }
            const saved = await writeSyncConfig(next);
            fillSyncForm();
            restartSyncTimer();
            if (!saved) {
                showToast('Sync settings could not be saved.', true);
                return;
            }
            showToast(syncConfigured() ? 'Sync settings saved. Syncing…' : 'Sync settings saved.');
            if (syncConfigured()) queueSync({ manual: true });
        });
        shadow.querySelector('.copy-sync-link').addEventListener('click', copySyncLink);
        shadow.querySelector('.sync-now').addEventListener('click', () => {
            if (!syncConfigured()) {
                showToast('Turn on cloud sync and save an endpoint first.', true);
                return;
            }
            queueSync({ manual: true });
        });
        shadow.addEventListener('keydown', event => {
            if (event.key === 'Escape') setPanelOpen(false);
        });

        fillSettingsForm();
        fillSyncForm();
        updateUi();
        ui.open = () => setPanelOpen(true);
    }

    function applyStoredState(stored) {
        const merged = mergeStoredState(stored, { adoptSettings: true });
        notePushBacklog();
        if (!merged) return false;
        pruneVisited();
        setRootState();
        processAllCards();
        fillSettingsForm();
        updateUi();
        return true;
    }

    function reloadRemoteState(newValue) {
        if (applyStoredState(newValue)) showToast('Settings synchronized from another tab.');
    }

    // Stand-in for GM_addValueChangeListener on engines that do not provide it: re-read and
    // merge whenever this tab comes back to the foreground, so its next write is not built
    // on a snapshot that other tabs have since moved past.
    async function refreshFromStorage() {
        if (document.visibilityState === 'hidden') return;
        applyStoredState(await readStoredState());
    }

    function onReady() {
        setRootState();
        createUi();
        processAllCards();
        observeDynamicContent();

        if (recordCurrentPageVisit()) {
            processAllCards();
            persistState();
        }

        document.addEventListener('click', onDocumentClick, true);
        document.addEventListener('auxclick', onAuxClick, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointerup', cancelLongPress, true);
        document.addEventListener('pointercancel', cancelLongPress, true);
        document.addEventListener('pointermove', cancelLongPress, true);
        document.addEventListener('pointerover', event => {
            const card = event.target instanceof Element ? event.target.closest('a.jvs-card') : null;
            if (card) setSelectedCard(card);
        }, true);
        document.addEventListener('focusin', event => {
            const card = event.target instanceof Element ? event.target.closest('a.jvs-card') : null;
            if (card) setSelectedCard(card);
        }, true);
        window.addEventListener('pageshow', () => {
            processAllCards();
            refreshFromStorage();
        });
        window.addEventListener('focus', () => {
            refreshFromStorage();
            syncOnFocus();
        });
        document.addEventListener('visibilitychange', () => {
            refreshFromStorage();
            if (document.visibilityState === 'visible') syncOnFocus();
        });

        let liveSync = false;
        try {
            GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
                if (remote) reloadRemoteState(decodeValue(newValue, STORAGE_KEY));
            });
            liveSync = true;
        } catch (error) {
            console.warn('[JVS] Cross-tab change notifications are unavailable.', error);
        }
        if (!liveSync) {
            syncTimer = window.setInterval(refreshFromStorage, SYNC_POLL_MS);
            window.addEventListener('pagehide', () => window.clearInterval(syncTimer));
        }

        restartSyncTimer();
        window.addEventListener('pagehide', () => {
            window.clearInterval(remotePollTimer);
            window.clearTimeout(remotePushTimer);
        });
        queueSync();
        offerPendingSyncLink();

        try {
            GM_registerMenuCommand('Open JavStore Cleanup settings', () => ui?.open());
            GM_registerMenuCommand('Reveal/protect all matched cards', toggleOverlays);
        } catch (error) {
            console.warn('[JVS] Userscript menu commands are unavailable.', error);
        }
    }

    async function boot() {
        syncConfig = await readSyncConfig();
        const snapshot = await readStorageSnapshot();
        const initialState = combineSnapshot(snapshot);
        settings = sanitizeSettings(initialState?.settings);
        visited = parseVisited(initialState?.visited);
        overrides = parseOverrides(initialState?.overrides);
        overrideTimes = parseTimestamps(initialState?.overrideTimes);
        tombstones = parseTimestamps(initialState?.tombstones);
        resetAt = parseTimestamp(initialState?.resetAt);
        prunedBefore = parseTimestamp(initialState?.prunedBefore);
        lastKnownUpdatedAt = parseTimestamp(initialState?.updatedAt);
        settingsUpdatedAt = parseTimestamp(initialState?.settingsUpdatedAt) || lastKnownUpdatedAt;
        settingTimes = documentSettingTimes(initialState);
        const replayed = replayPendingVisits();
        pruneVisited();
        await migrateLegacyHistory();
        if (replayed || journalsAhead(snapshot)) persistState();
        setRootState();

        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        onReady();
    }

    boot();
})();
