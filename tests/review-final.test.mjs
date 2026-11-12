// Final adversarial review of 6.12.0's history and sync design under AdGuard's per-tab
// storage snapshots. Each test here reproduces a defect found in that review; the
// accompanying report ranks them.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor,
    listingHtml, detailHtml, card, pressOnCard, visitedUrls,
} from './harness.mjs';

const CARDS = [['/a.html', 'Alpha'], ['/b.html', 'Beta'], ['/c.html', 'Gamma'], ['/d.html', 'Delta']];
const listing = () => listingHtml(CARDS);
const u = href => `https://javstore.net${href}`;
const MIN = 60000;
const CONFIG_KEY = 'javstore_sync_config_v1';
const SESSION_KEY = 'javstore_sync_session_v1';

afterEach(closeTabs);

// One clock for every tab of the device, which a test can move forward.
function device(options = {}) {
    const store = makeStore({ snapshotPerTab: true, ...options });
    const clock = { offset: 0 };
    const open = (extra = {}) => openTab(store, {
        html: listing(),
        ...extra,
        beforeRun: window => {
            const realNow = window.Date.now.bind(window.Date);
            window.Date.now = () => realNow() + clock.offset;
        },
    });
    return { store, clock, open };
}

const isVisited = (tab, href) => card(tab.window, href).classList.contains('jvs-visited');

// R1. A page's journal key is named after the moment the page loaded, not the moment it is
// first written. A tab that sits idle for longer than JOURNAL_ROTATE_MS and then records
// something writes a key whose name already says "final since minutes ago". A newer tab
// folds it into the main document, the next one retires it at once, and a third tab that
// loaded before the write—still young enough to write the main document—writes its older
// view over the top. Nothing is left holding the visit.
test('R1 a long-idle tab\'s first journal write is not treated as final the moment it lands', async () => {
    const { store, clock, open } = device();
    // A main document exists, so retirement has something to check coverage against.
    await open({ html: detailHtml, url: u('/d.html') });
    await settle();
    assert.deepEqual(visitedUrls(store), [u('/d.html')]);

    const old = await open(); // loads at 0 and records nothing for 20 minutes
    clock.offset = 15 * MIN;
    const young = await open(); // loads at 15; may write the main document until 23

    clock.offset = 20 * MIN;
    pressOnCard(old.window, '/a.html', 'v'); // its first save: journal only, key named "0"
    await settle();
    assert.ok(store.journals().some(key => store.read(key)?.visited?.[u('/a.html')]),
        'the old tab journaled a');

    clock.offset = 20.5 * MIN;
    await open(); // folds the journal into the main document
    await settle();
    assert.ok(visitedUrls(store).includes(u('/a.html')));

    clock.offset = 21 * MIN;
    await open(); // finds it covered and, by the key's name, long final
    await settle();

    clock.offset = 22 * MIN;
    pressOnCard(young.window, '/c.html', 'v'); // a young tab, loaded before a was recorded
    await settle();

    clock.offset = 23 * MIN;
    const fresh = await open();
    await settle();
    assert.ok(isVisited(fresh, '/c.html'));
    assert.ok(isVisited(fresh, '/a.html'), 'the visit the long-idle tab recorded survives');
});

// R2. The outbox records one "sent" mark per change, whichever worker confirmed it, while
// sync positions are kept per worker. A change made while the device synced with worker B
// is marked sent; when the device is pointed back at worker A, whose position it still
// holds, only outstanding changes go up, so A never gets it—and nor does any other device
// syncing with A.
test('R2 a change confirmed by one worker still reaches another worker this device returns to', async () => {
    const first = makeRemote({ origin: 'https://one.test' });
    const second = makeRemote({ origin: 'https://two.test' });
    const store = makeStore();
    const remotes = [first, second];

    enableSync(store, first);
    await openTab(store, { html: detailHtml, url: u('/a.html'), remote: remotes });
    await waitFor(() => first.visited().includes(u('/a.html')));
    await settle(100);
    closeTabs();

    enableSync(store, second);
    await openTab(store, { html: detailHtml, url: u('/b.html'), remote: remotes });
    await waitFor(() => second.visited().includes(u('/b.html')));
    await settle(100);
    closeTabs();

    enableSync(store, first);
    const before = first.requests.length;
    await openTab(store, { html: listing(), remote: remotes });
    await waitFor(() => first.requests.length > before);
    await settle(100);
    assert.deepEqual(first.visited(), [u('/a.html'), u('/b.html')],
        'b, recorded while syncing with the other worker, reaches the first one');
});

// R3. journalSince never moves forward, and every pull lowers it to the oldest row it took
// on. One row another device recorded days ago (a phone that was offline, a visit synced
// late) is enough: from then on, every save by that tab writes a journal holding every
// visit and tombstone stamped since—here the whole 4,900-visit history—for as long as the
// tab stays open. Old tabs on AdGuard write nothing else, so they each carry it.
test('R3 pulling one old row does not make every later save write the whole history to the journal', async () => {
    const now = Date.now();
    const visited = {};
    for (let i = 0; i < 4900; i++) {
        visited[`https://javstore.net/${600000 + i}-FC2-PPV-${3000000 + i}-Some-Typical-Title-Words-pn.html`] = now - 86400000 + i;
    }
    const store = makeStore({ snapshotPerTab: true });
    store.write('javstore_cleanup_state_v2', {
        version: 3, updatedAt: now - 1000, resetAt: 0, prunedBefore: 0, settings: {}, settingTimes: {},
        visited, overrides: {}, overrideTimes: {}, tombstones: {},
    });
    const remote = makeRemote();
    // Another device's visit, pushed late, stamped two days ago.
    remote.store.sync({ cursor: 0, changes: [{ kind: 'v', key: u('/b.html'), at: now - 2 * 86400000 }] });
    enableSync(store, remote);

    const tab = await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt, { timeout: 20000 });
    await settle(100);
    assert.ok(isVisited(tab, '/b.html'), 'the old row was pulled');

    pressOnCard(tab.window, '/a.html', 'v');
    await settle(100);
    const sizes = store.journals().map(key => store.data.get(key).length);
    const largest = Math.max(0, ...sizes);
    assert.ok(largest < 20000,
        `a one-visit save writes a journal of ${(largest / 1024).toFixed(0)} KB`);
});

// R4. After the update, the user reloads the JavStore tabs that were open (or restarts the
// browser, which restores them). The history was saved by 6.11.0 and has no position, so
// each tab uploads everything it holds and downloads everything the worker holds. Web
// Locks put the tabs one after another, but each reads its own snapshot, taken before the
// first finished, so every one of them repeats the whole exchange.
test('R4 tabs reloaded together after the update re-exchange the whole history once, not once per tab', async () => {
    const now = Date.now();
    const remote = makeRemote();
    const visited = {};
    const changes = [];
    for (let i = 0; i < 2000; i++) {
        const key = `https://javstore.net/${600000 + i}-FC2-PPV-${3000000 + i}-Some-Typical-Title-Words-pn.html`;
        visited[key] = now - 86400000 + i;
        changes.push({ kind: 'v', key, at: visited[key] });
    }
    remote.store.sync({ cursor: 0, changes });
    const store = makeStore({ snapshotPerTab: true });
    // What 6.11.0 left: no position and no outbox in the history, the cursor in the config.
    store.write('javstore_cleanup_state_v2', {
        version: 3, scriptVersion: '6.11.0', updatedAt: now - 1000, resetAt: 0, prunedBefore: 0,
        settings: {}, settingTimes: {}, historyId: 'h1', visited, overrides: {}, overrideTimes: {}, tombstones: {},
    });
    enableSync(store, remote, { remoteKey: remote.endpoint, cursor: 2000, pushedAt: now - 500, historyId: 'h1' });
    store.write(SESSION_KEY, {
        endpoint: remote.endpoint, historyId: 'h1', completedAt: now - 3600000, activeAt: now - 3600000,
    });

    const tabs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        openTab(store, { html: listing(), remote, url: `https://javstore.net/page/${i + 1}` })));
    await waitFor(() => remote.requests.length >= 6, { timeout: 30000 });
    await settle(400);
    const uploaded = remote.requests.reduce((sum, request) => sum + (request.body?.changes?.length || 0), 0);
    assert.equal(tabs.length, 6);
    assert.ok(uploaded <= 2 * 2000,
        `${uploaded} changes uploaded for a 2,000-visit history over ${remote.requests.length} requests`);
});

// R5. Rotation writes the new journal key and then deletes the previous one. AdGuard does
// not report a write that fails (a full quota, say, which R3's journals make likelier), so
// when the new key does not land the delete still does, and what the long-open tab had
// safely stored—and nowhere else, since it may not write the main document—is gone.
test('R5 a journal rotation whose new key never lands does not delete the key it replaces', async () => {
    const { store, clock, open } = device();
    await open({ html: detailHtml, url: u('/d.html') });
    await settle();
    const old = await open();

    clock.offset = 9 * MIN; // too old to write the main document
    pressOnCard(old.window, '/a.html', 'v');
    await settle();
    assert.ok(store.journals().some(key => store.read(key)?.visited?.[u('/a.html')]), 'a is journaled');

    clock.offset = 15 * MIN; // past JOURNAL_ROTATE_MS: the next save moves to a new key
    const set = store.set;
    store.set = async function (key, value) {
        if (key.startsWith('javstore_journal_')) return; // dropped without an error
        return set.call(this, key, value);
    };
    pressOnCard(old.window, '/b.html', 'v');
    await settle();
    store.set = set;

    const fresh = await open();
    await settle();
    assert.ok(isVisited(fresh, '/a.html'), 'the visit stored before the failed write is still stored');
});
