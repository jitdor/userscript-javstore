import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor,
    listingHtml, detailHtml, card, pressOnCard, visitedUrls, syncPosition,
} from './harness.mjs';

const SESSION_KEY = 'javstore_sync_session_v1';
const CONFIG_KEY = 'javstore_sync_config_v1';
const STATE_KEY = 'javstore_cleanup_state_v2';
const listing = () => listingHtml([['/old.html', 'Old'], ['/new.html', 'New']]);
afterEach(closeTabs);

function seededRemote(count = 775) {
    const remote = makeRemote();
    const at = Date.now() - 60000;
    remote.store.sync({ cursor: 0, changes: Array.from({ length: count }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/${i ? `old-${i}` : 'old'}.html`, at,
    })) });
    remote.responses = [];
    const handle = remote.handle.bind(remote);
    remote.handle = async request => {
        const response = await handle(request);
        remote.responses.push(JSON.parse(response.text));
        return response;
    };
    return remote;
}

async function restored(remote, store = makeStore(), options = {}) {
    enableSync(store, remote);
    const tab = await openTab(store, { html: listing(), remote, ...options });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    return { store, tab };
}

async function manualSync(tab, store) {
    const previous = store.read(SESSION_KEY)?.completedAt || 0;
    tab.shadow().querySelector('.sync-now').click();
    await waitFor(() => store.read(SESSION_KEY)?.completedAt > previous);
    await settle();
}

test('775 visits are downloaded once across navigation and new tabs', async () => {
    const remote = seededRemote();
    const { store } = await restored(remote);
    const session = new Map();
    for (let page = 2; page <= 5; page++) {
        const tab = await openTab(store, { html: listing(), remote, session, url: `https://javstore.net/page/${page}` });
        assert.ok(card(tab.window, '/old.html').classList.contains('jvs-visited'));
        assert.doesNotMatch(tab.shadow().textContent, /Restored \d+ visited URLs/);
    }
    await settle();
    assert.equal(remote.requests.length, 1);
    assert.equal(remote.responses.flatMap(response => response.changes).length, 775);
    assert.equal(visitedUrls(store).length, 775);
});

test('50 context-menu detail tabs batch visits without repeating the initial download', async () => {
    const remote = seededRemote();
    const { store } = await restored(remote);
    const tabs = await Promise.all(Array.from({ length: 50 }, (_, i) => openTab(store, {
        remote, html: detailHtml, url: `https://javstore.net/new-${i}.html`,
    })));
    await waitFor(() => visitedUrls(store).length === 825, { timeout: 15000 });
    // Advancing the listing must paint the stored history without another startup pull.
    const next = await openTab(store, { remote, html: listing(), url: 'https://javstore.net/page/2' });
    assert.ok(card(next.window, '/old.html').classList.contains('jvs-visited'));
    await waitFor(() => remote.visited().length === 825, { timeout: 15000 });
    // Let every tab's debounce fire: redundant callbacks should make no network request.
    await new Promise(resolve => setTimeout(resolve, 4500));
    assert.equal(remote.requests.filter(request => request.body.cursor === 0).length, 1);
    assert.ok(remote.requests.length <= 3, `expected batched uploads, got ${remote.requests.length} requests`);
    for (const tab of tabs) assert.doesNotMatch(tab.shadow().textContent, /Restored \d+ visited URLs/);
    assert.equal(remote.visited().length, 825);
});

test('an old tab reads the cursor advanced by another tab before syncing', async () => {
    const remote = seededRemote(1);
    const { store, tab: old } = await restored(remote);
    const newer = await openTab(store, { html: listing(), remote });
    remote.store.sync({ cursor: 0, changes: [{ kind: 'v', key: 'https://javstore.net/new.html', at: Date.now() }] });
    await manualSync(newer, store);
    const cursor = syncPosition(store);
    await manualSync(old, store);
    assert.equal(remote.requests.at(-1).body.cursor, cursor);
    assert.equal(remote.responses.at(-1).changes.length, 0);
    assert.ok(card(old.window, '/new.html').classList.contains('jvs-visited'));
});

test('concurrent first tabs share one restoration', async () => {
    const remote = seededRemote();
    const store = makeStore({ latency: 3 });
    enableSync(store, remote);
    await Promise.all(Array.from({ length: 8 }, () => openTab(store, { html: listing(), remote })));
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle(300);
    assert.equal(remote.requests.length, 1);
    assert.equal(visitedUrls(store).length, 775);
});

test('idle session expiry checks for new rows without discarding the cursor', async () => {
    const remote = seededRemote(1);
    const { store } = await restored(remote);
    const cursor = syncPosition(store);
    const session = store.read(SESSION_KEY);
    store.write(SESSION_KEY, { ...session, activeAt: Date.now() - 31 * 60000 });
    await openTab(store, { html: listing(), remote });
    await waitFor(() => remote.requests.length === 2);
    assert.equal(remote.requests.at(-1).body.cursor, cursor);
    assert.equal(remote.responses.at(-1).changes.length, 0);
});

test('lost history bypasses the session marker, then the next page reuses the recovery', async () => {
    const remote = seededRemote(1);
    const { store } = await restored(remote);
    closeTabs();
    store.data.delete(STATE_KEY);
    store.journals().forEach(key => store.data.delete(key));
    const previous = store.read(SESSION_KEY).completedAt;
    await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
    assert.equal(remote.requests.at(-1).body.cursor, 0);
    assert.equal(visitedUrls(store).length, 1);
    await openTab(store, { html: listing(), remote });
    await settle();
    assert.equal(remote.requests.length, 2);
});

test('a rejected history write does not mark restoration complete', async () => {
    const remote = seededRemote(1);
    const store = makeStore();
    enableSync(store, remote);
    const set = store.set.bind(store);
    const history = key => key === STATE_KEY || key.startsWith('javstore_journal_');
    store.set = async (key, value) => { if (!history(key)) await set(key, value); };
    const tab = await openTab(store, { html: listing(), remote });
    await waitFor(() => tab.shadow().textContent.includes('Could not save'));
    await settle(200);
    assert.equal(store.read(SESSION_KEY), undefined);
    assert.equal(syncPosition(store), 0);
    store.set = set;
    await manualSync(tab, store);
    assert.ok(syncPosition(store) > 0);
    assert.ok(store.read(SESSION_KEY).completedAt);
});

// Without Web Locks, and without notice of other tabs' writes, a lease kept in storage
// cannot exclude anything (each tab reads back its own claim), and one left behind by a
// closed tab would hold the next ones up. Tabs then sync side by side: a few duplicate
// requests, and the same history.
test('without Web Locks, first tabs sync side by side without waiting on a stale lease', async () => {
    const remote = seededRemote(1);
    const store = makeStore({ latency: 2 });
    enableSync(store, remote);
    store.write('javstore_sync_lease_v1', { owner: 'closed-tab', expiresAt: Date.now() + 90000 });
    const started = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => openTab(store, { html: listing(), remote, webLocks: false })));
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle(600);
    assert.ok(Date.now() - started < 8000, 'held up by a lease');
    assert.ok(remote.requests.length <= 5);
    assert.equal(visitedUrls(store).length, 1);
});

test('an incomplete paged download resumes on the next page instead of marking the session ready', async () => {
    const remote = seededRemote(13);
    const handle = remote.handle.bind(remote);
    remote.handle = request => handle({ ...request, body: JSON.stringify({ ...JSON.parse(request.body), limit: 1 }) });
    const store = makeStore();
    enableSync(store, remote);
    await openTab(store, { html: listing(), remote });
    await waitFor(() => syncPosition(store) === 12);
    assert.equal(store.read(SESSION_KEY), undefined);
    await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    assert.equal(remote.requests.length, 13);
    assert.equal(remote.requests.at(-1).body.cursor, 12);
    assert.equal(visitedUrls(store).length, 13);
});

test('foreground tabs share periodic refresh and hidden tabs do not poll', async () => {
    const remote = seededRemote(1);
    const { store } = await restored(remote);
    const polls = [];
    for (let i = 0; i < 4; i++) {
        await openTab(store, { html: listing(), remote, beforeRun(window) {
            Object.defineProperty(window.document, 'visibilityState', { value: i === 3 ? 'hidden' : 'visible' });
            const setInterval = window.setInterval.bind(window);
            window.setInterval = (callback, ms) => {
                if (ms === 5 * 60000) polls.push(callback);
                return setInterval(callback, ms);
            };
        } });
    }
    store.write(SESSION_KEY, { ...store.read(SESSION_KEY), completedAt: Date.now() - 6 * 60000 });
    polls[3]();
    await settle();
    assert.equal(remote.requests.length, 1, 'hidden tab stays idle');
    polls.slice(0, 3).forEach(poll => poll());
    await waitFor(() => remote.requests.length === 2);
    await settle();
    assert.equal(remote.requests.length, 2, 'only one foreground refresh');
    assert.equal(remote.responses.at(-1).changes.length, 0);
});

// AdGuard hands each tab the storage it had when the tab loaded. A tab left open that long
// writes back an older history: one that lacks what other tabs and devices have since
// added, and that carries whatever history id it was loaded with. The cursor used to live
// only in the sync configuration, so the next page either took that older copy for a lost
// history and downloaded everything with a "Restored" note—on every page, for as long as
// the old tab kept writing—or, with the ids agreeing, trusted a cursor the copy did not
// reach and lost the difference for good.
test('an older history written back by a long-open tab catches up quietly from its own place', async () => {
    const remote = seededRemote(300);
    const store = makeStore({ snapshotPerTab: true });
    await restored(remote, store);
    const old = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/1' });
    const reachedByOld = syncPosition(store);

    // Another device adds visits, then this device loses its history while the old tab
    // stays open. The next page is a genuine recovery, and says so once.
    const at = Date.now() - 30000;
    remote.store.sync({ cursor: 0, changes: Array.from({ length: 30 }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/elsewhere-${i}.html`, at: at + i,
    })) });
    store.data.delete(STATE_KEY);
    store.journals().forEach(key => store.data.delete(key));
    let previous = store.read(SESSION_KEY).completedAt;
    const first = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/2' });
    await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
    assert.match(first.shadow().textContent, /Restored 330 visited URLs/);
    assert.equal(visitedUrls(store).length, 330);

    // The old tab records a visit: its write puts back the history it loaded with.
    pressOnCard(old.window, '/new.html', 'v');
    await waitFor(() => visitedUrls(store).length === 301);

    previous = store.read(SESSION_KEY).completedAt;
    const requests = remote.requests.length;
    const next = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/3' });
    await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
    assert.equal(remote.requests[requests].body.cursor, reachedByOld, 'it resumes where the older copy reaches');
    assert.doesNotMatch(next.shadow().textContent, /Restored \d+ visited URLs/);
    assert.equal(visitedUrls(store).length, 331);
    assert.ok(visitedUrls(store).includes('https://javstore.net/elsewhere-0.html'));
    assert.ok(visitedUrls(store).includes('https://javstore.net/new.html'));
});
