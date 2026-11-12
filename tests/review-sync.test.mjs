// Review of the cloud sync protocol under AdGuard's per-tab storage snapshots.
//
// Every test here models AdGuard: each tab reads GM storage as it was when the tab loaded,
// plus its own writes (makeStore({ snapshotPerTab: true })). Tests that fail on the
// current script document a defect; the report that accompanies this file ranks them.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor,
    listingHtml, detailHtml, visitedUrls, pressOnCard,
} from './harness.mjs';

const SESSION_KEY = 'javstore_sync_session_v1';
const CONFIG_KEY = 'javstore_sync_config_v1';
const STATE_KEY = 'javstore_cleanup_state_v2';
const listing = () => listingHtml([['/old.html', 'Old'], ['/new.html', 'New']]);
afterEach(closeTabs);

function seededRemote(count = 1, at = Date.now() - 60000) {
    const remote = makeRemote();
    remote.store.sync({ cursor: 0, changes: Array.from({ length: count }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/${i ? `old-${i}` : 'old'}.html`, at: at + i,
    })) });
    return remote;
}

function closeTab(tab) {
    tab.window.dispatchEvent(new tab.window.Event('pagehide'));
    tab.window.close();
}

async function syncNow(tab, remote) {
    const before = remote.requests.length;
    tab.shadow().querySelector('.sync-now').click();
    await waitFor(() => remote.requests.length > before);
    await settle(100);
}

async function firstTab(remote, store, options = {}) {
    enableSync(store, remote, options.config);
    const tab = await openTab(store, { html: listing(), remote, ...options });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle();
    return tab;
}

// F1. The push horizon is a device-wide claim ("everything stamped before pushedAt is on
// the worker") written by whichever tab syncs, from that tab's view of storage. A tab that
// loaded before a visit was recorded cannot see it, yet still moves the horizon past it.
test('F1 a long-open tab syncing does not strand a visit another tab recorded but had not pushed', async () => {
    const remote = seededRemote();
    const store = makeStore({ snapshotPerTab: true });
    await firstTab(remote, store);
    const old = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/2' });

    // An item tab records its visit and is closed before its 4 s upload debounce fires.
    const item = await openTab(store, { html: detailHtml, remote, url: 'https://javstore.net/x.html' });
    await waitFor(() => visitedUrls(store).includes('https://javstore.net/x.html'));
    closeTab(item);

    // The long-open listing tab syncs (focus/poll/Sync now) and records its horizon.
    await syncNow(old, remote);
    assert.ok(!remote.visited().includes('https://javstore.net/x.html'));

    // Every later page on this device, even a manual sync, should still send it.
    const next = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/3' });
    await new Promise(resolve => setTimeout(resolve, 4500));
    await syncNow(next, remote);
    assert.ok(visitedUrls(store).includes('https://javstore.net/x.html'), 'still held locally');
    assert.ok(remote.visited().includes('https://javstore.net/x.html'), 'visit stranded on this device');
});

// F2. runSync writes `{ ...syncConfig, cursor, pushedAt, ... }` where syncConfig was read
// from the syncing tab's snapshot. Endpoint, token and the enabled flag go back with it.
test('F2 a long-open tab syncing does not revert sync settings changed in a newer tab', async () => {
    const remote = seededRemote();
    const store = makeStore({ snapshotPerTab: true });
    await firstTab(remote, store);
    const old = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/2' });

    // The user turns sync off in a new tab (same for a rotated token or new endpoint).
    const settingsTab = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/3' });
    const shadow = settingsTab.shadow();
    const enabled = shadow.querySelector('.sync-form input[type="checkbox"]');
    enabled.checked = false;
    shadow.querySelector('.sync-form').dispatchEvent(new settingsTab.window.Event('submit', { cancelable: true }));
    await waitFor(() => store.read(CONFIG_KEY).enabled === false);

    // The old tab regains focus after a minute and syncs.
    await syncNow(old, remote);
    assert.equal(store.read(CONFIG_KEY).enabled, false, 'sync was switched back on by a stale tab');
});

// F3. At the 5,000-visit cap, a stale tab still holds (and writes back) the oldest visits
// that newer tabs have pruned. The next merge in a fresh tab adopts them as "backdated",
// lowers the push horizon to the oldest of them, and the next sync re-uploads the entire
// history, every time a stale tab writes. The same happens without snapshots: another
// page's journal (kept for 10 minutes) carries the pruned visits back just the same.
test('F3 at the visit cap, a stale tab writing back pruned visits does not trigger a full re-upload', async () => {
    const base = Date.now() - 86400000;
    const remote = makeRemote();
    const store = makeStore({ snapshotPerTab: true });
    // 5,000 visits already on the device and the worker, all pushed.
    const visited = {};
    for (let i = 0; i < 5000; i++) visited[`https://javstore.net/v-${i}.html`] = base + i;
    remote.store.sync({ cursor: 0, changes: Object.entries(visited).map(([key, at]) => ({ kind: 'v', key, at })) });
    store.write(STATE_KEY, { version: 3, updatedAt: base + 5000, visited, settings: {} });
    await firstTab(remote, store, { config: {} });
    const stale = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/2' });

    // New visits in fresh tabs push the oldest out of the capped history.
    for (let i = 0; i < 3; i++) {
        const tab = await openTab(store, { html: detailHtml, remote, url: `https://javstore.net/new-${i}.html` });
        await waitFor(() => remote.visited().includes(`https://javstore.net/new-${i}.html`), { timeout: 15000 });
        closeTab(tab);
    }
    // The stale tab records a visit of its own: its write carries the pruned visits back.
    pressOnCard(stale.window, '/new.html', 'v');
    await waitFor(() => visitedUrls(store).includes('https://javstore.net/new.html'));
    await new Promise(resolve => setTimeout(resolve, 4500));

    const fresh = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/3' });
    pressOnCard(fresh.window, '/old.html', 'v');
    const before = remote.requests.length;
    await new Promise(resolve => setTimeout(resolve, 5000));
    await settle(200);
    const pushed = remote.requests.slice(before).flatMap(request => request.body.changes || []);
    assert.ok(pushed.length < 50, `re-uploaded ${pushed.length} rows for one new visit`);
});

// F4. After the endpoint changes, a tab opened before the change keeps stamping the history
// with the old worker's position (its own syncConfig still names the old endpoint, so
// adoptSyncedThrough keeps it). Every new page then finds no position for the new worker
// while the config has a cursor, takes that for lost history, and downloads everything.
test('F4 after an endpoint change, a stale tab does not make every page re-download the whole history', async () => {
    const first = seededRemote(50);
    const second = makeRemote({ origin: 'https://sync2.test' });
    second.store.sync({ cursor: 0, changes: Array.from({ length: 50 }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/second-${i}.html`, at: Date.now() - 50000 + i,
    })) });
    const store = makeStore({ snapshotPerTab: true });
    await firstTab(first, store);
    const stale = await openTab(store, { html: listing(), remote: [first, second], url: 'https://javstore.net/page/2' });

    // Repoint this device at the second worker in a newer tab.
    const config = store.read(CONFIG_KEY);
    store.write(CONFIG_KEY, { ...config, endpoint: second.endpoint });
    const repointed = await openTab(store, { html: listing(), remote: [first, second], url: 'https://javstore.net/page/3' });
    await waitFor(() => second.requests.length >= 1);
    await settle(200);

    // The stale tab saves a visit: its document carries the first worker's position.
    pressOnCard(stale.window, '/new.html', 'v');
    await waitFor(() => visitedUrls(store).includes('https://javstore.net/new.html'));
    await settle(200);
    closeTab(repointed);

    const fullPulls = () => second.requests.filter(request => request.body.cursor === 0).length;
    const pullsBefore = fullPulls();
    const next = await openTab(store, { html: listing(), remote: [first, second], url: 'https://javstore.net/page/4' });
    await settle(300);
    assert.doesNotMatch(next.shadow().textContent, /Restored \d+ visited URLs/);
    assert.equal(fullPulls(), pullsBefore, 'a new page downloaded the whole history again');
});

// F5. A startup inside a live session never downloads. activeAt is refreshed by every page
// load, so a device browsing listing pages continuously never sees visits made on another
// device until it records a visit of its own, regains focus, or a foreground tab survives
// a whole poll interval without navigating.
test('F5 continuous navigation still picks up another device\'s visits within the poll interval', async () => {
    const remote = seededRemote();
    const store = makeStore({ snapshotPerTab: true });
    await firstTab(remote, store);
    // The iPhone records a visit.
    remote.store.sync({ cursor: 0, changes: [{ kind: 'v', key: 'https://javstore.net/new.html', at: Date.now() }] });
    // Ten minutes of browsing listing pages later (session last completed 10 min ago,
    // last active a moment ago), a new listing page opens.
    const session = store.read(SESSION_KEY);
    store.write(SESSION_KEY, { ...session, completedAt: Date.now() - 10 * 60000, activeAt: Date.now() - 1000 });
    const before = remote.requests.length;
    await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/9' });
    await settle(200);
    assert.ok(remote.requests.length > before, 'no download for 10 minutes of navigation');
});

// F6. Under per-tab snapshots the GM-storage lease cannot exclude anything: each tab only
// ever reads back its own claim. Two tabs syncing at once both download and both push.
test('F6 the storage lease serializes two tabs under per-tab snapshots', async () => {
    const remote = seededRemote(300);
    const store = makeStore({ snapshotPerTab: true, latency: 5 });
    enableSync(store, remote);
    await Promise.all([0, 1].map(() => openTab(store, { html: listing(), remote, webLocks: false })));
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle(300);
    assert.equal(remote.requests.filter(request => request.body.cursor === 0).length, 1);
});

// F7. Cost of a 50-tab context-menu burst on AdGuard. The batching in 6.11.0 relies on each
// tab seeing the horizon the first upload recorded; under per-tab snapshots no item tab
// sees another's upload, so every tab uploads (and downloads) on its own.
test('F7 a 50-tab burst under per-tab snapshots batches its uploads', async () => {
    const remote = seededRemote(300);
    const store = makeStore({ snapshotPerTab: true });
    await firstTab(remote, store);
    const before = remote.requests.length;
    await Promise.all(Array.from({ length: 50 }, (_, i) => openTab(store, {
        remote, html: detailHtml, url: `https://javstore.net/burst-${i}.html`,
    })));
    await waitFor(() => remote.visited().length === 350, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 4500));
    const requests = remote.requests.length - before;
    const rows = remote.requests.slice(before).reduce((sum, request) => sum + (request.body.changes || []).length, 0);
    assert.ok(requests <= 5, `50 visits cost ${requests} requests carrying ${rows} rows`);
});

// F8. A worker that comes back empty at the same URL (Durable Object recreated, storage
// reset) is never re-seeded: the device's cursor is past everything the new worker holds,
// and its push horizon says every local visit is already upstream.
test('F8 a worker reset at the same endpoint is re-seeded from the device', async () => {
    const remote = seededRemote(20);
    const store = makeStore();
    const tab = await firstTab(remote, store);
    const fresh = makeRemote();
    remote.store = fresh.store;
    remote.handle = fresh.handle;
    remote.requests = fresh.requests;
    remote.visited = fresh.visited;
    await syncNow(tab, fresh);
    assert.equal(fresh.visited().length, 20, 'the reset worker stays empty');
});
