import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, openTab, closeTabs, settle, listingHtml, detailHtml, detailWithRelatedHtml,
    card, clickCard, pressOnCard, openInNewTabFromContextMenu, visitedUrls, waitFor,
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

// A sibling tab's stale document can land between this tab's write and the read-back
// that checks it. The read-back then carries a newer timestamp — so the write looks
// good — while the visit it was supposed to save has been clobbered out of it. The
// replay note is the only copy left, and it matters most exactly here: Cmd-clicking a
// tile leaves the listing where it is, so nothing re-reads storage until the user
// refreshes, and a note given up on that report takes the visit with it.
test('a visit clobbered between the write and the read-back is replayed', async () => {
    const store = makeStore();
    const session = new Map();
    const tiles = [['/a.html', 'Alpha'], ['/b.html', 'Beta']];
    const clicked = ['https://javstore.net/a.html', 'https://javstore.net/b.html'];

    const listingTab = await openTab(store, {
        html: listingHtml(tiles), url: 'https://javstore.net/', session,
    });
    await settle();

    let clobbering = true;
    const write = store.set.bind(store);
    store.set = async (key, value) => {
        await write(key, value);
        if (key !== 'javstore_cleanup_state_v2' || !clobbering) return;
        // What another tab holding a pre-click snapshot writes a moment later.
        const stale = JSON.parse(store.data.get(key));
        clicked.forEach(url => { delete stale.visited[url]; });
        stale.updatedAt += 1000;
        store.data.set(key, JSON.stringify(stale));
    };

    clickCard(listingTab.window, '/a.html');
    clickCard(listingTab.window, '/b.html');
    await settle();
    assert.ok(card(listingTab.window, '/a.html').classList.contains('jvs-visited'));
    assert.deepEqual(visitedUrls(store), [], 'the sibling tab clobbered both out of storage');

    assert.deepEqual(
        JSON.parse(session.get('javstore_pending_visits') || '[]').map(entry => entry.url).sort(),
        clicked,
        'the replay note is kept, because storage did not come back carrying the clicks',
    );

    // The user refreshes the listing, which is the next thing to read storage.
    clobbering = false;
    listingTab.window.close();
    const reloaded = await openTab(store, {
        html: listingHtml(tiles), url: 'https://javstore.net/', session,
    });
    await settle();
    assert.ok(card(reloaded.window, '/a.html').classList.contains('jvs-visited'), '/a.html came back');
    assert.ok(card(reloaded.window, '/b.html').classList.contains('jvs-visited'), '/b.html came back');
    assert.deepEqual(visitedUrls(store), clicked);
});

test('a numbered category listing with its own heading is not recorded as a visit', async () => {
    const store = makeStore();
    await openTab(store, {
        html: listing().replace('<main>', '<main><h1>AV Uncensored</h1>'),
        url: 'https://javstore.net/416-av-uncensored-page-2-cn.html',
        referrer: 'https://javstore.net/',
    });
    await settle();
    assert.deepEqual(visitedUrls(store), []);
});

// The workflow that lost visits: Ctrl-click several tiles on a listing, move on to the
// next page and do it again. Every Ctrl-click saves from the listing and every tab it
// opens saves again as it loads, so on a slow engine several whole-document writes are in
// flight at once, and one built from an older read drops what another just saved.
test('a burst of Ctrl-clicks across tabs on slow storage loses nothing', async () => {
    const PAGE_ONE = Array.from({ length: 6 }, (_, index) => [`/one-${index}.html`, `One ${index}`]);
    const PAGE_TWO = Array.from({ length: 6 }, (_, index) => [`/two-${index}.html`, `Two ${index}`]);
    const clicked = [...PAGE_ONE, ...PAGE_TWO].map(([href]) => `https://javstore.net${href}`).sort();

    for (let round = 0; round < 3; round += 1) {
        const store = makeStore({ latency: 150 });
        const session = new Map();
        const opening = [];
        const browse = async (tiles, url) => {
            const listingTab = await openTab(store, { html: listingHtml(tiles), url, session });
            for (const [href] of tiles) {
                clickCard(listingTab.window, href);
                opening.push(openTab(store, {
                    html: detailWithRelatedHtml(), url: `https://javstore.net${href}`,
                }));
                await new Promise(resolve => setTimeout(resolve, 30));
            }
        };
        await browse(PAGE_ONE, 'https://javstore.net/');
        await browse(PAGE_TWO, 'https://javstore.net/416-av-uncensored-page-2-cn.html');
        await Promise.all(opening);
        await new Promise(resolve => setTimeout(resolve, 3000));

        const reloaded = await openTab(store, { html: listingHtml([...PAGE_ONE, ...PAGE_TWO]) });
        const unmarked = () => [...PAGE_ONE, ...PAGE_TWO]
            .filter(([href]) => !card(reloaded.window, href).classList.contains('jvs-visited'))
            .map(([href]) => href);
        // The reload's own read takes a few slow round trips before anything is marked.
        await waitFor(() => reloaded.window.document.querySelector('a.jvs-card')).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.deepEqual(unmarked(), [], `round ${round}: every Ctrl-clicked tile is marked after a reload`);
        await waitFor(() => clicked.every(url => visitedUrls(store).includes(url)));
        // Closing a jsdom window with a slow write still in flight crashes jsdom itself.
        await new Promise(resolve => setTimeout(resolve, 2000));
        closeTabs();
    }
});

test('a visit a racing write dropped from the main document comes back from the journal', async () => {
    const store = makeStore();
    const tab = await openTab(store, { html: listing() });
    const before = store.state();
    clickCard(tab.window, '/a.html');
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);

    // Another tab that read before the click writes its document back after it.
    store.data.set('javstore_cleanup_state_v2', JSON.stringify({ ...before, updatedAt: Date.now() + 1000 }));
    assert.deepEqual(visitedUrls(store), []);

    const reloaded = await openTab(store, { html: listing() });
    assert.ok(card(reloaded.window, '/a.html').classList.contains('jvs-visited'));
    await waitFor(() => visitedUrls(store).length === 1);
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('a journal is retired once it has sat past its TTL, and not before', async () => {
    const store = makeStore();
    const first = await openTab(store, { html: listing() });
    clickCard(first.window, '/a.html');
    await settle();
    const [firstJournal] = store.journals();
    assert.ok(firstJournal, 'the click is journaled');

    const second = await openTab(store, { html: listing() });
    clickCard(second.window, '/b.html');
    await settle();
    assert.ok(store.journals().includes(firstJournal), 'a recent journal is kept');

    const aged = JSON.parse(store.data.get(firstJournal));
    aged.writtenAt -= 11 * 60000;
    store.data.set(firstJournal, JSON.stringify(aged));
    clickCard(second.window, '/c.html');
    await settle();
    assert.ok(!store.journals().includes(firstJournal), 'the aged journal is retired');
    assert.deepEqual(visitedUrls(store), CARDS.map(([href]) => `https://javstore.net${href}`));
});

test('an engine without GM_listValues keeps history in the single document', async () => {
    const store = makeStore({ journaling: false });
    const tab = await openTab(store, { html: listing() });
    clickCard(tab.window, '/a.html');
    await settle();
    assert.deepEqual(store.journals(), []);

    const reloaded = await openTab(store, { html: listing() });
    assert.ok(card(reloaded.window, '/a.html').classList.contains('jvs-visited'));
});
