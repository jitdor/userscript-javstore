import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, openTab, closeTabs, settle, listingHtml, detailHtml, detailWithRelatedHtml,
    card, clickCard, pressOnCard, openInNewTabFromContextMenu, visitedUrls,
} from './harness.mjs';

const CARDS = [['/a.html', 'Alpha'], ['/b.html', 'Beta'], ['/c.html', 'Gamma']];
const listing = () => listingHtml(CARDS);

afterEach(closeTabs);

test('a click is stored', async () => {
    const store = makeStore();
    const tab = await openTab(store, { html: listing() });
    clickCard(tab.window, '/a.html');
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('history survives a reload', async () => {
    const store = makeStore();
    const first = await openTab(store, { html: listing() });
    clickCard(first.window, '/a.html');
    await settle();

    const reloaded = await openTab(store, { html: listing() });
    assert.ok(card(reloaded.window, '/a.html').classList.contains('jvs-visited'));
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('a tab holding an older snapshot does not wipe what another tab recorded', async () => {
    const store = makeStore();
    const older = await openTab(store, { html: listing() });
    const newer = await openTab(store, { html: listing() });

    clickCard(newer.window, '/b.html');
    await settle();
    clickCard(older.window, '/a.html');
    await settle();

    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html', 'https://javstore.net/b.html']);
});

test('a tab holding an older snapshot does not resurrect an unmarked item', async () => {
    const store = makeStore();
    const older = await openTab(store, { html: listing() });
    clickCard(older.window, '/a.html');
    await settle();

    const newer = await openTab(store, { html: listing() });
    pressOnCard(older.window, '/a.html', 'v');
    await settle();
    assert.deepEqual(visitedUrls(store), []);

    clickCard(newer.window, '/b.html');
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/b.html']);
});

test('a tab holding an older snapshot does not undo a cleared history', async () => {
    const store = makeStore();
    const older = await openTab(store, { html: listing() });
    clickCard(older.window, '/a.html');
    clickCard(older.window, '/b.html');
    await settle();

    const newer = await openTab(store, { html: listing() });
    older.shadow().querySelector('.clear').click();
    await settle();
    assert.deepEqual(visitedUrls(store), []);

    clickCard(newer.window, '/c.html');
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/c.html']);
});

test('a click lost to the page unload is replayed on the next load', async () => {
    const store = makeStore();
    const session = new Map();
    const listingTab = await openTab(store, { html: listing(), session });

    store.dropWrites = true;
    clickCard(listingTab.window, '/a.html');
    await settle();
    assert.deepEqual(visitedUrls(store), [], 'precondition: the asynchronous write never landed');

    store.dropWrites = false;
    await openTab(store, {
        html: detailHtml,
        url: 'https://javstore.net/a.html',
        referrer: 'https://javstore.net/',
        session,
    });
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('landing on a detail page records the visit without a click', async () => {
    const store = makeStore();
    await openTab(store, {
        html: detailHtml,
        url: 'https://javstore.net/b.html',
        referrer: 'https://javstore.net/',
    });
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/b.html']);
});

test('opening a card from the context menu records the visit when its page loads', async () => {
    const store = makeStore();
    const listingTab = await openTab(store, { html: listing() });

    // The right-click itself must not record anything: the page cannot tell "open in new
    // tab" from "copy link", and the browser never reports which one was chosen.
    openInNewTabFromContextMenu(listingTab.window, '/a.html');
    await settle();
    assert.deepEqual(visitedUrls(store), []);

    // The new tab is a fresh one: no referrer of its own, and the item page carries the
    // related cards a real one does.
    await openTab(store, {
        html: detailWithRelatedHtml(),
        url: 'https://javstore.net/a.html',
    });
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);

    listingTab.window.dispatchEvent(new listingTab.window.Event('focus'));
    await settle();
    assert.ok(card(listingTab.window, '/a.html').classList.contains('jvs-visited'));
});

test('an item page carrying related cards is not mistaken for a listing', async () => {
    const store = makeStore();
    await openTab(store, {
        html: detailWithRelatedHtml([['/b.html', 'Beta'], ['/c.html', 'Gamma']]),
        url: 'https://javstore.net/a.html',
        referrer: 'https://javstore.net/',
    });
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('an item page reached without a referrer is recorded', async () => {
    const store = makeStore();
    await openTab(store, { html: detailHtml, url: 'https://javstore.net/a.html' });
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('a listing page on an unrecognized path is not recorded as a visit', async () => {
    const store = makeStore();
    await openTab(store, {
        html: listing(),
        url: 'https://javstore.net/newest',
        referrer: 'https://javstore.net/',
    });
    await settle();
    assert.deepEqual(visitedUrls(store), []);
});

test('a listing page is not recorded as a visit', async () => {
    const store = makeStore();
    await openTab(store, {
        html: listing(),
        url: 'https://javstore.net/page/2',
        referrer: 'https://javstore.net/',
    });
    await settle();
    assert.deepEqual(visitedUrls(store), []);
});

test('a tab picks up other tabs history when it regains focus', async () => {
    const store = makeStore();
    const background = await openTab(store, { html: listing() });
    const foreground = await openTab(store, { html: listing() });

    clickCard(foreground.window, '/b.html');
    await settle();
    background.window.dispatchEvent(new background.window.Event('focus'));
    await settle();

    assert.ok(card(background.window, '/b.html').classList.contains('jvs-visited'));
});

test('settings still round-trip through storage', async () => {
    const store = makeStore();
    const tab = await openTab(store, { html: listing() });
    const form = tab.shadow().querySelector('form');
    form.elements.mode.value = 'blur';
    form.dispatchEvent(new tab.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(store.state().settings.mode, 'blur');

    const reloaded = await openTab(store, { html: listing() });
    assert.equal(reloaded.shadow().querySelector('form').elements.mode.value, 'blur');
});

test('per-card overrides survive a write from a tab holding an older snapshot', async () => {
    const store = makeStore();
    const older = await openTab(store, { html: listing() });
    const newer = await openTab(store, { html: listing() });

    pressOnCard(newer.window, '/b.html', 'o');
    await settle();
    assert.equal(store.state().overrides['https://javstore.net/b.html'], 'allow');

    clickCard(older.window, '/a.html');
    await settle();
    assert.equal(store.state().overrides['https://javstore.net/b.html'], 'allow');
});
