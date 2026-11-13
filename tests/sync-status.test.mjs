// The on-page sync status: a sync that takes more than a moment says so, a tab whose sync
// waits on another tab's says that, and a tab in view sees another tab's sync through the
// shared Web Lock—the one thing AdGuard's tabs can see of each other.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor, listingHtml,
} from './harness.mjs';

const SESSION_KEY = 'javstore_sync_session_v1';
const listing = () => listingHtml([['/a.html', 'Alpha']]);
afterEach(closeTabs);

const status = tab => {
    const pill = tab.shadow().querySelector('.sync-status');
    return pill.hidden ? '' : pill.textContent;
};

// A worker whose answers can be held back, so a sync stays in progress while the test looks.
function slowRemote(rows = 1500) {
    const remote = makeRemote();
    const at = Date.now() - 60000;
    remote.store.sync({ cursor: 0, changes: Array.from({ length: rows }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/v-${i}.html`, at: at + i,
    })) });
    const handle = remote.handle.bind(remote);
    remote.gate = null;
    remote.handle = async request => {
        if (remote.gate) await remote.gate.promise;
        return handle(request);
    };
    remote.hold = () => {
        let release;
        remote.gate = { promise: new Promise(resolve => { release = resolve; }) };
        remote.gate.release = () => { remote.gate = null; release(); };
        return remote.gate;
    };
    return remote;
}

test('a first download shows its progress, then says when it is complete', async () => {
    const remote = slowRemote();
    const store = makeStore();
    enableSync(store, remote);
    const gate = remote.hold();
    const tab = await openTab(store, { html: listing(), remote });
    await waitFor(() => /Downloading history/.test(status(tab)));
    assert.match(tab.shadow().querySelector('.sync-status').title, /Wait for "Sync complete"/);
    gate.release();
    await waitFor(() => status(tab) === 'Sync complete');
    await waitFor(() => status(tab) === '', { timeout: 5000 });
});

test('a quick sync shows nothing', async () => {
    const remote = makeRemote();
    const store = makeStore();
    enableSync(store, remote);
    const tab = await openTab(store, { html: listing(), remote });
    let seen = '';
    const watch = setInterval(() => { seen = seen || status(tab); }, 5);
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle(100);
    clearInterval(watch);
    assert.equal(seen, '');
});

test('a tab whose sync waits on another tab\'s says so until that one finishes', async () => {
    const remote = slowRemote();
    const store = makeStore({ snapshotPerTab: true });
    enableSync(store, remote);
    const gate = remote.hold();
    const first = await openTab(store, { html: listing(), remote });
    await waitFor(() => /Downloading history/.test(status(first)));
    // Opened while the first tab is still downloading: its own sync queues behind it.
    const second = await openTab(store, { html: listing(), remote });
    await waitFor(() => /Waiting for another tab to sync/.test(status(second)));
    gate.release();
    await waitFor(() => !/Waiting/.test(status(second)), { timeout: 5000 });
});

test('a tab with nothing of its own to sync shows another tab\'s sync through the lock', async () => {
    const remote = slowRemote();
    const store = makeStore();
    enableSync(store, remote);
    const settled = await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt, { timeout: 10000 });
    await waitFor(() => status(settled) === '', { timeout: 5000 });
    // Another tab starts a long manual sync; this tab, idle, only sees the lock held.
    const gate = remote.hold();
    const busy = await openTab(store, { html: listing(), remote });
    busy.shadow().querySelector('.sync-now').click();
    await waitFor(() => /Another tab is syncing/.test(status(settled)), { timeout: 8000 });
    gate.release();
    await waitFor(() => status(settled) === 'Sync complete' || status(settled) === '', { timeout: 8000 });
});
