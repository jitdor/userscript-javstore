import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor,
    listingHtml, pressOnCard, visitedUrls, syncPosition,
} from './harness.mjs';

const SESSION_KEY = 'javstore_sync_session_v1';
const CONFIG_KEY = 'javstore_sync_config_v1';
const STATE_KEY = 'javstore_cleanup_state_v2';
const listing = () => listingHtml([['/old.html', 'Old'], ['/new.html', 'New']]);
afterEach(closeTabs);

function seededRemote(count) {
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

async function restored(remote, store) {
    enableSync(store, remote);
    const tab = await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle();
    return tab;
}

// What a tab still running 6.11.0 writes: it never heard of `syncedThrough`, so its
// serializeState drops the field, and under AdGuard it carries the history id of the
// storage it loaded with.
function writtenBy6110Tab(doc, historyId = doc.historyId) {
    const { syncedThrough: _dropped, ...rest } = doc;
    return { ...rest, historyId, updatedAt: Date.now() };
}

function dropJournals(store) {
    // Journals retire JOURNAL_TTL_MS (10 min) after a verified save; past that the main
    // document is the only local copy.
    store.journals().forEach(key => store.data.delete(key));
}

// Updating the script does not reload the tabs AdGuard already injected 6.11.0 into. The
// reported device had ~40 of them open, swapping two history ids. Until every one of them
// is reloaded, each of their writes leaves a document with no stamp and the other id,
// and 6.11.1 still reads that as a lost history: a full download and the toast, on every
// page that follows such a write: the exact symptom the release is meant to end.
test('a stamp-less document written by a still-open 6.11.0 tab catches up without "Restored" on every page', async () => {
    const remote = seededRemote(300);
    const store = makeStore({ snapshotPerTab: true });
    await restored(remote, store);
    const loadedByOldTab = store.state();
    // Since the old tab loaded, another device added visits and a page here pulled them.
    remote.store.sync({ cursor: 0, changes: Array.from({ length: 20 }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/elsewhere-${i}.html`, at: Date.now() - 1000 + i,
    })) });
    store.write(SESSION_KEY, { ...store.read(SESSION_KEY), activeAt: 0 });
    const before = store.read(SESSION_KEY).completedAt;
    await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/1' });
    await waitFor(() => store.read(SESSION_KEY).completedAt > before);
    await settle();
    for (let round = 0; round < 2; round += 1) {
        // The old tab records a visit: its whole document goes back with its own id.
        store.write(STATE_KEY, writtenBy6110Tab(loadedByOldTab, 'id-from-before-the-loss'));
        dropJournals(store);
        const previous = store.read(SESSION_KEY).completedAt;
        const requests = remote.requests.length;
        const page = await openTab(store, { html: listing(), remote, url: `https://javstore.net/page/${round + 2}` });
        await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
        await settle();
        assert.doesNotMatch(page.shadow().textContent, /Restored \d+ visited URLs/, `round ${round}`);
        // A copy written without a position says nothing about how far it reaches, so it
        // is downloaded again in full, quietly—the price while tabs from before the update
        // stay open—and nothing the copy lacks is left out.
        assert.ok(visitedUrls(store).includes('https://javstore.net/elsewhere-0.html'), `round ${round}`);
    }
});

// The other half of the same transition: when the old 6.11.0 tab and the configuration
// agree on the id, the stamp-less fallback trusts the configuration's cursor, which the old
// copy does not reach. The rows in between are never downloaded, and the save that follows
// writes a stamp claiming they are held, so nothing after the old tabs close repairs it.
test('a stamp-less older copy with the matching id still catches up instead of trusting the configuration cursor', async () => {
    const remote = seededRemote(50);
    const store = makeStore({ snapshotPerTab: true });
    await restored(remote, store);
    const loadedByOldTab = store.state();

    // Another device adds visits; a page on this device pulls them.
    remote.store.sync({ cursor: 0, changes: Array.from({ length: 20 }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/elsewhere-${i}.html`, at: Date.now() - 1000 + i,
    })) });
    store.write(SESSION_KEY, { ...store.read(SESSION_KEY), activeAt: 0 });
    let previous = store.read(SESSION_KEY).completedAt;
    await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/2' });
    await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
    await settle();
    assert.equal(visitedUrls(store).length, 70);

    // The 6.11.0 tab, loaded before that, writes back its copy with the same id.
    store.write(STATE_KEY, writtenBy6110Tab(loadedByOldTab));
    dropJournals(store);
    store.write(SESSION_KEY, { ...store.read(SESSION_KEY), activeAt: 0 });
    previous = store.read(SESSION_KEY).completedAt;
    await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/3' });
    await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
    await settle();
    assert.ok(visitedUrls(store).includes('https://javstore.net/elsewhere-0.html'), 'pulled rows lost for good');
    assert.equal(visitedUrls(store).length, 70);
});

// A push-only sync moves the cursor (the worker numbers this device's own rows), and 6.11.1
// now rewrites and re-reads the whole history document for that alone. On AdGuard that is
// ~500 KB serialized, written, and read back again, for rows the document already holds.
// One visit should cost one save of the history, not two.
test('a visit that is only pushed up saves the history document once', async () => {
    const remote = seededRemote(1);
    const store = makeStore();
    const tab = await restored(remote, store);
    let saves = 0;
    const set = store.set.bind(store);
    store.set = async (key, value) => {
        if (key === STATE_KEY) saves += 1;
        return set(key, value);
    };
    const requests = remote.requests.length;
    pressOnCard(tab.window, '/new.html', 'v');
    await waitFor(() => remote.requests.length > requests, { timeout: 9000 });
    await waitFor(() => syncPosition(store) === 2);
    await settle(80);
    assert.equal(saves, 1, `history document saved ${saves} times for one pushed visit`);
});

function remoteTag(endpoint) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < endpoint.length; index += 1) {
        hash ^= endpoint.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

// runSync means to drop the stamp after a document-only exchange (`reached` is empty for
// `legacy`), but the save that follows re-adopts the old stamp from storage, because an
// empty in-memory stamp never outranks a stored one. The configuration is reset to
// cursor 0 / remoteKey '' as before, yet the next exchange with a cursor-speaking worker
// at that address resumes from the stale stamp instead of 0, which 6.11.0 never did
// (its cursor required `sameRemote`).
test('a document-only exchange forgets the stamp, so a worker that speaks cursors again starts from zero', async () => {
    const v3 = makeRemote();
    v3.store.sync({ cursor: 0, changes: [{ kind: 'v', key: 'https://javstore.net/new.html', at: Date.now() - 5000 }] });
    const legacy = {
        async handle({ body }) {
            const parsed = JSON.parse(body);
            if (parsed.state) {
                legacy.document = { ...legacy.document, visited: { ...legacy.document.visited, ...parsed.state.visited } };
            }
            return { status: 200, statusText: '', text: JSON.stringify({ state: legacy.document }) };
        },
        document: { version: 3, updatedAt: Date.now(), visited: {} },
        endpoint: v3.endpoint,
        token: v3.token,
        requests: [],
    };
    const store = makeStore();
    enableSync(store, legacy);
    // This device last spoke to a cursor worker at the same address, up to row 500.
    store.write(STATE_KEY, {
        version: 3, updatedAt: Date.now() - 10000, historyId: 'h',
        syncedThrough: { remote: remoteTag(v3.endpoint), cursor: 500 },
        visited: { 'https://javstore.net/old.html': Date.now() - 20000 },
    });
    await openTab(store, { html: listing(), remote: legacy });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle();

    const previous = store.read(SESSION_KEY).completedAt;
    await openTab(store, { html: listing(), remote: v3 });
    await waitFor(() => store.read(SESSION_KEY).completedAt > previous);
    await settle();
    assert.equal(v3.requests[0].body.cursor, 0);
    assert.ok(visitedUrls(store).includes('https://javstore.net/new.html'));
});
