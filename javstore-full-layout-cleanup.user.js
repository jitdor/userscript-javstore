// ==UserScript==
// @name         JavStore Full Layout Cleanup - No Sidebars + Mosaic Overlay
// @namespace    http://tampermonkey.net/
// @version      6.0.1
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
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '6.0.1';
    const STORAGE_VERSION = 2;
    const STORAGE_KEY = 'javstore_cleanup_state_v2';
    const LEGACY_STORAGE_KEY = 'javstore_seen_links';
    const MAX_VISITED_ITEMS = 5000;
    const CARD_SELECTOR = 'main .grid a[href]';

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
        visitedOpacity: 0.7,
        retentionDays: 0,
        hideSidebar: true,
        overlayLifted: false,
        filter: 'all',
    });

    const VALID_MODES = new Set(['tint', 'blur', 'hide']);
    const VALID_FILTERS = new Set(['all', 'unvisited', 'visited', 'matched']);
    const VALID_STRATEGIES = new Set(['word', 'substring', 'regex']);

    let settings;
    let visited = new Map();
    let overrides = new Map();
    let storageAvailable = true;
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
    async function readStoredState() {
        try {
            const state = await Promise.resolve(GM_getValue(STORAGE_KEY, null));
            if (!state || typeof state !== 'object') return null;
            return state;
        } catch (error) {
            storageAvailable = false;
            console.warn('[JVS] Isolated storage is unavailable.', error);
            return null;
        }
    }

    function serializeState() {
        return {
            version: STORAGE_VERSION,
            scriptVersion: SCRIPT_VERSION,
            updatedAt: Date.now(),
            settings: { ...settings },
            visited: Object.fromEntries(visited),
            overrides: Object.fromEntries(overrides),
        };
    }

    function persistState() {
        if (!storageAvailable) return Promise.resolve(false);
        try {
            return Promise.resolve(GM_setValue(STORAGE_KEY, serializeState()))
                .then(() => true)
                .catch(error => {
                    storageAvailable = false;
                    console.warn('[JVS] Could not save settings or visited history.', error);
                    showToast('Could not save—userscript storage is unavailable.', true);
                    return false;
                });
        } catch (error) {
            storageAvailable = false;
            console.warn('[JVS] Could not save settings or visited history.', error);
            showToast('Could not save—userscript storage is unavailable.', true);
            return Promise.resolve(false);
        }
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
        }

        if (visited.size > MAX_VISITED_ITEMS) {
            [...visited.entries()]
                .sort((a, b) => a[1] - b[1])
                .slice(0, visited.size - MAX_VISITED_ITEMS)
                .forEach(([url]) => visited.delete(url));
        }
    }

    settings = sanitizeSettings();
    visited = new Map();
    overrides = new Map();

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
            GM_addStyle(pageCss);
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
        if (shouldVisit) visited.set(url, Date.now());
        else visited.delete(url);
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
        if (!current) overrides.set(url, 'allow');
        else if (current === 'allow') overrides.set(url, 'block');
        else overrides.delete(url);
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

    function updateCounts() {
        if (!ui) return;
        const counts = getCounts();
        ui.summary.textContent = `${counts.matched} matched · ${counts.visited} visited`;
        ui.counts.textContent = `${counts.total} cards on this page · ${counts.stored} visited URLs stored`;
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
        ui.toastTimer = window.setTimeout(() => ui?.toast.classList.remove('show'), 2800);
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
        elements.visitedOpacity.value = settings.visitedOpacity;
        elements.retentionDays.value = settings.retentionDays;
        elements.hideSidebar.checked = settings.hideSidebar;
        elements.filter.value = settings.filter;
    }

    function applySettings(nextSettings, message = 'Settings applied.') {
        settings = sanitizeSettings(nextSettings);
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
            const parsed = JSON.parse(await file.text());
            if (!parsed || typeof parsed !== 'object') throw new Error('Invalid backup');
            if (!window.confirm('Replace current settings, history, and per-card overrides with this backup?')) return;
            settings = sanitizeSettings(parsed.settings);
            visited = parseVisited(parsed.visited);
            overrides = parseOverrides(parsed.overrides);
            pruneVisited();
            persistState();
            setRootState();
            processAllCards();
            fillSettingsForm();
            updateUi();
            showToast('Backup imported.');
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
                <button class="pill lift" type="button">Reveal all</button>
                <button class="pill summary" type="button" aria-expanded="false">JavStore controls</button>
            </div>
            <section class="panel" hidden aria-label="JavStore cleanup settings">
                <div class="panel-header">
                    <div><h2>JavStore Cleanup</h2><p class="muted">Version ${SCRIPT_VERSION}</p></div>
                    <button class="icon-button close" type="button" aria-label="Close settings">×</button>
                </div>
                <p class="warning storage-warning" hidden>Private storage is unavailable. Changes will work for this page but cannot be saved.</p>
                <p class="counts muted"></p>
                <form>
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
        const form = shadow.querySelector('form');
        const selectedActions = [...shadow.querySelectorAll('.selected-actions button')];
        ui = {
            host, shadow, panel, summary, liftButton, form, selectedActions,
            counts: shadow.querySelector('.counts'),
            storageWarning: shadow.querySelector('.storage-warning'),
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
                updateUi();
                shadow.querySelector('.close').focus();
            }
        }

        summary.addEventListener('click', () => setPanelOpen(panel.hidden));
        shadow.querySelector('.close').addEventListener('click', () => setPanelOpen(false));
        liftButton.addEventListener('click', toggleOverlays);
        form.addEventListener('submit', event => {
            event.preventDefault();
            applySettings(readSettingsForm());
        });
        shadow.querySelector('.reset').addEventListener('click', () => {
            applySettings({ ...DEFAULT_SETTINGS }, 'Default settings restored.');
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
            visited.clear();
            persistState();
            processAllCards();
            showToast('Visited history cleared.');
        });
        shadow.addEventListener('keydown', event => {
            if (event.key === 'Escape') setPanelOpen(false);
        });

        fillSettingsForm();
        updateUi();
        ui.open = () => setPanelOpen(true);
    }

    function reloadRemoteState(newValue) {
        if (!newValue || typeof newValue !== 'object') return;
        settings = sanitizeSettings(newValue.settings);
        visited = parseVisited(newValue.visited);
        overrides = parseOverrides(newValue.overrides);
        pruneVisited();
        setRootState();
        processAllCards();
        fillSettingsForm();
        updateUi();
        showToast('Settings synchronized from another tab.');
    }

    function onReady() {
        setRootState();
        createUi();
        processAllCards();
        observeDynamicContent();

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
        window.addEventListener('pageshow', () => processAllCards());

        try {
            GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
                if (remote) reloadRemoteState(newValue);
            });
        } catch (error) {
            console.warn('[JVS] Cross-tab synchronization is unavailable.', error);
        }

        try {
            GM_registerMenuCommand('Open JavStore Cleanup settings', () => ui?.open());
            GM_registerMenuCommand('Reveal/protect all matched cards', toggleOverlays);
        } catch (error) {
            console.warn('[JVS] Userscript menu commands are unavailable.', error);
        }
    }

    async function boot() {
        const initialState = await readStoredState();
        settings = sanitizeSettings(initialState?.settings);
        visited = parseVisited(initialState?.visited);
        overrides = parseOverrides(initialState?.overrides);
        pruneVisited();
        await migrateLegacyHistory();
        setRootState();

        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        onReady();
    }

    boot();
})();
