// Adversarial review of 6.13.1's part storage (values too large for AdGuard stored as parts
// behind a pointer) and its storage probe. Each test reproduces a defect; the report that
// came with this file ranks them. Tests P3 and P4 model AdGuard behaviour the platform
// notes leave open (unordered delivery of in-flight writes; the value JSON-encoded before
// it is URL-encoded); each says which assumption it makes.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, openTab, closeTabs, settle, waitFor, listingHtml, clickCard, visitedUrls,
} from './harness.mjs';

const STATE_KEY = 'javstore_cleanup_state_v2';
const PROBE_KEY = 'javstore_storage_probe_v1';
const PART_PREFIX = 'javstore_part_';
const CARDS = Array.from({ length: 20 }, (_, i) => [`/c-${i}.html`, `Card ${i}`]);
const listing = () => listingHtml(CARDS);

afterEach(closeTabs);

function history(count, at = Date.now() - 86400000) {
    const visited = {};
    for (let i = 0; i < count; i++) {
        visited[`https://javstore.net/${600000 + i}-FC2-PPV-${3000000 + i}-Some-Title-pn.html`] = at + i;
    }
    return { version: 3, updatedAt: at + count, visited, settings: {} };
}

const partSets = store => new Set([...store.data.keys()]
    .filter(key => key.startsWith(PART_PREFIX)).map(key => key.replace(/_\d+$/, '')));
const storedBytes = store => [...store.data.values()]
    .reduce((sum, raw) => sum + encodeURIComponent(JSON.parse(raw)).length, 0);
const visitedCount = tab => Number(/(\d+) visited URLs stored/.exec(tab.shadow().textContent)?.[1] ?? -1);
const openPanel = tab => tab.shadow().querySelector('.summary').click();

// One clock for every tab of the device, which a test can move forward.
function device(store) {
    const clock = { offset: 0 };
    const open = (extra = {}) => openTab(store, {
        html: listing(),
        ...extra,
        beforeRun: window => {
            const realNow = window.Date.now.bind(window.Date);
            window.Date.now = () => realNow() + clock.offset;
        },
    });
    return { clock, open };
}

// P1 (perf). A page trims only part sets it replaced itself, and only once it has written
// the same key twice more. An ordinary page writes the history once (the click that leaves
// it), so every page load leaves a full copy of the history behind for PART_RETIRE_MS (30
// minutes). AdGuard embeds every stored value into each page it injects into, so browsing
// at a page or two a minute makes each page load carry dozens of copies of the history.
test('P1 browsing page after page does not leave a full copy of the history per page load', async () => {
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 8006 });
    store.write(PROBE_KEY, { limit: 8000, measuredAt: Date.now() });
    store.write(STATE_KEY, history(1000));
    const docBytes = storedBytes(store);
    const session = new Map();
    for (let page = 0; page < 12; page++) {
        const tab = await openTab(store, { html: listing(), session });
        // A page someone reads for a moment before clicking on.
        await new Promise(resolve => setTimeout(resolve, 1000));
        clickCard(tab.window, `/c-${page}.html`);
        await settle(60);
        // The click navigates: the page is gone, and its timers with it.
        tab.window.dispatchEvent(new tab.window.Event('pagehide'));
        tab.window.close();
    }
    // The next page in the tab replays the last click, which left before it was saved.
    await openTab(store, { html: listing(), session });
    await settle(100);
    // Every visit is held: in the history, or (for a page left before its history save
    // landed) in that page's journal, which the next page folds in.
    const held = new Set(visitedUrls(store));
    store.journals().forEach(key => Object.keys(store.read(key)?.visited || {}).forEach(url => held.add(url)));
    assert.equal(held.size, 1012);
    const sets = partSets(store).size;
    assert.ok(sets <= 3, `${sets} part sets of the history in storage after 12 page loads`);
    assert.ok(storedBytes(store) < 4 * docBytes,
        `${Math.round(storedBytes(store) / 1000)} KB stored for a ${Math.round(docBytes / 1000)} KB history`);
});

// P2 (perf). Every page that loads before the probe pointer has landed starts a probe of its
// own (40 tabs restored at browser start all do), and the judge deletes only the values of
// the token the pointer names. The other tokens' 2 KB and 8 KB values stay in storage for
// good: nothing else ever removes javstore_probe_* keys, and they ride along in every page.
test('P2 probes started by tabs loading together leave no probe values behind', async () => {
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 30000 });
    const { clock, open } = device(store);
    await Promise.all([open(), open(), open(), open()]);
    await settle(100);
    clock.offset = 60000;
    await open(); // judges the probe the pointer names
    await settle(100);
    clock.offset = 120000;
    await open();
    await settle(100);
    assert.equal(store.read(PROBE_KEY)?.limit, 8000, 'the limit was measured');
    const left = [...store.data.keys()].filter(key => key.startsWith('javstore_probe_'));
    assert.deepEqual(left, [], `${left.length} probe values left behind for good`);
});

// P3 (data loss). A value with one part missing reads as missing, and the page then writes
// the history it has—empty, or only what its journals hold—over the pointer. The set the
// key used before is kept in storage on purpose ("if the newest pointer never landed, the
// one before still finds its parts"), but the pointer does not name it, so nothing reads
// it, and the next save replaces the whole history even though a complete copy is right
// there. Before parts, a value either landed whole or left the previous one in place.
test('P3 a pointer with a missing part falls back to the complete set kept before it', async () => {
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 8006 });
    store.write(PROBE_KEY, { limit: 6000, measuredAt: Date.now() });
    const old = history(400);
    const text = JSON.stringify(old);
    const cut = (id, missing) => {
        const third = Math.ceil(text.length / 3);
        for (let i = 0; i < 3; i++) {
            if (i !== missing) store.data.set(`${PART_PREFIX}${id}_${i}`, JSON.stringify(text.slice(i * third, (i + 1) * third)));
        }
    };
    // The set a page wrote a minute ago (complete), then its next one, which lost a part.
    const before = `${(Date.now() - 60000).toString(36)}-prev0001`;
    const latest = `${(Date.now() - 30000).toString(36)}-prev0002`;
    cut(before, -1);
    cut(latest, 1);
    // The pointer names the set it replaced, as every pointer written with a set before it does.
    store.data.set(STATE_KEY, JSON.stringify(JSON.stringify({
        __jvsParts: 3, id: latest, length: text.length, prev: { id: before, count: 3, length: text.length },
    })));

    const tab = await openTab(store, { html: listing() });
    await settle(50);
    clickCard(tab.window, '/c-1.html');
    await settle(100);
    const later = await openTab(store, { html: listing() });
    await settle(50);
    openPanel(later);
    assert.ok(visitedCount(later) >= 400, `${visitedCount(later)} visits stored after one click`);
});

// P3b (data loss). The newest set is still missing a part when a page loads, so the page
// reads the set before it. That part then lands. A save from the older copy must not
// replace the pointer while the newest set may still complete, or the visits only it holds
// are gone.
test('P3b a page that read the previous set does not write over a newest set still arriving', async () => {
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 8006 });
    store.write(PROBE_KEY, { limit: 6000, measuredAt: Date.now() });
    const older = history(400);
    const newer = history(400);
    const extra = 'https://javstore.net/999999-FC2-PPV-9999999-Only-In-Newest-pn.html';
    newer.visited[extra] = Date.now() - 20000;
    const parts = (id, value) => {
        const text = JSON.stringify(value);
        const third = Math.ceil(text.length / 3);
        return { text, pieces: [0, 1, 2].map(i => [`${PART_PREFIX}${id}_${i}`, JSON.stringify(text.slice(i * third, (i + 1) * third))]) };
    };
    const before = `${(Date.now() - 60000).toString(36)}-prev0001`;
    const latest = `${(Date.now() - 30000).toString(36)}-prev0002`;
    const a = parts(before, older);
    const b = parts(latest, newer);
    a.pieces.forEach(([key, raw]) => store.data.set(key, raw));
    store.data.set(b.pieces[0][0], b.pieces[0][1]);
    store.data.set(b.pieces[2][0], b.pieces[2][1]);
    store.data.set(STATE_KEY, JSON.stringify(JSON.stringify({
        __jvsParts: 3, id: latest, length: b.text.length, prev: { id: before, count: 3, length: a.text.length },
    })));

    const tab = await openTab(store, { html: listing() });
    await settle(50);
    // The late part lands after the page took its snapshot.
    store.data.set(b.pieces[1][0], b.pieces[1][1]);
    clickCard(tab.window, '/c-1.html');
    await settle(800);
    assert.ok(visitedUrls(store).includes(extra), 'the visit only the newest set held was lost');
});

// P4 (data loss; assumes AdGuard's GM_setValue resolves once the page's own copy is updated
// and the requests to the app are in flight side by side). A click saves and navigates.
// storeValue sends every part at once and the pointer right after; the pointer is a tiny
// request and lands first, the page unloads, and the larger part requests still uploading
// are lost. The next page reads the history as missing and, replaying the click, writes a
// one-visit history over it. With one value per key, a cancelled save left the old one.
test('P4 a click that navigates while parts are uploading does not lose the history', async () => {
    const store = makeStore({ snapshotPerTab: true });
    const views = [];
    store.view = () => {
        const seen = new Map(store.data);
        const view = {
            alive: true,
            async get(key, fallback) { return seen.has(key) ? JSON.parse(seen.get(key)) : fallback; },
            async set(key, value) {
                seen.set(key, JSON.stringify(value));
                // Upload time grows with the request: a 6 KB part takes a few ms, a pointer none.
                const ms = Math.floor(encodeURIComponent(value).length / 2000);
                setTimeout(() => {
                    if (!view.alive) return;
                    store.data.set(key, JSON.stringify(value));
                    // The click's navigation completes as soon as the pointer is in.
                    if (key === STATE_KEY && String(value).includes('__jvsParts')) view.alive = false;
                }, ms);
            },
            async list() { return [...seen.keys()]; },
            async delete(key) {
                seen.delete(key);
                setTimeout(() => { if (view.alive) store.data.delete(key); }, 0);
            },
        };
        views.push(view);
        return view;
    };
    store.write(PROBE_KEY, { limit: 6000, measuredAt: Date.now() });
    store.write(STATE_KEY, history(400));
    const session = new Map();
    const first = await openTab(store, { html: listing(), session });
    await settle(50);
    // A click saves the history; the page is then left the moment that save's pointer is in.
    first.window.document.querySelector('main .grid a[href="/c-1.html"]')
        .dispatchEvent(new first.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await waitFor(() => !views[0].alive, { timeout: 3000 });
    const next = await openTab(store, { html: listing(), session });
    await settle(100);
    const third = await openTab(store, { html: listing() });
    await settle(100);
    openPanel(third);
    assert.ok(visitedCount(third) >= 400, `${visitedCount(third)} visits stored after the click`);
    assert.ok(next);
});

// P5 (data loss; assumes AdGuard JSON-encodes the value it is handed before URL-encoding
// it, as it must to carry non-string values). storeValue already hands GM_setValue a JSON
// string and parts are slices of JSON text, so every `"` in them costs `%5C%22`, not the
// `%22` encodedLength counts—a history slice runs ~6% larger than measured. The probe's
// 'a'.repeat values have no quotes, so they measure the limit itself exactly. Parts are cut
// with only the 5% margin splitEncoded happens to leave, and whole values with none, so on
// a device whose limit lies just above a probe size, parts are dropped while the pointer
// lands, and the history reads as missing.
test('P5 parts survive when the manager counts the value JSON-encoded', async () => {
    const store = makeStore({ snapshotPerTab: true });
    const limit = 8200; // keeps the 8 KB probe ('a' x 8000 is 8006 JSON+URL-encoded)
    const set = store.set.bind(store);
    store.set = async (key, value) => {
        if (encodeURIComponent(JSON.stringify(value)).length > limit) return;
        return set(key, value);
    };
    const { clock, open } = device(store);
    await open();
    await settle(100);
    clock.offset = 60000;
    await open();
    await settle(100);
    assert.equal(store.read(PROBE_KEY)?.limit, 8000, 'the probe measured 8 KB');

    store.write(STATE_KEY, history(400));
    const writer = await open();
    await settle(50);
    clickCard(writer.window, '/c-1.html');
    await settle(100);
    const reader = await open();
    await settle(50);
    openPanel(reader);
    assert.doesNotMatch(reader.shadow().textContent, /some stored values were missing parts/);
    assert.ok(visitedCount(reader) >= 401, `${visitedCount(reader)} visits read back`);
});
