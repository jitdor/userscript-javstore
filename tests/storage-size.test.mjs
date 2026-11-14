// AdGuard sends each stored value to its app as one request with the value URL-encoded in
// it, and a value too large for that request is dropped without the script being told; the
// page that wrote it still reads it back. A history of a thousand visits is far past that,
// so it never survived a page load, and every page downloaded it again with "Restored N".
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor, listingHtml, visitedUrls,
} from './harness.mjs';

const SESSION_KEY = 'javstore_sync_session_v1';
const listing = () => listingHtml([['/a.html', 'Alpha']]);
afterEach(closeTabs);

function seeded(count) {
    const remote = makeRemote();
    const at = Date.now() - 86400000;
    remote.store.sync({ cursor: 0, changes: Array.from({ length: count }, (_, i) => ({
        kind: 'v', key: `https://javstore.net/${600000 + i}-FC2-PPV-${3000000 + i}-Some-Title-pn.html`, at: at + i,
    })) });
    return remote;
}

const restoredNote = tab => /Restored \d+ visited URLs/.test(tab.shadow().textContent);

test('a large history survives page loads on a manager that drops oversized values', async () => {
    const remote = seeded(1034);
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 8000 });
    enableSync(store, remote);
    const first = await openTab(store, { html: listing(), remote, url: 'https://javstore.net/page/1' });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt, { timeout: 20000 });
    await settle(200);
    for (let page = 2; page <= 4; page += 1) {
        const requests = remote.requests.length;
        const tab = await openTab(store, { html: listing(), remote, url: `https://javstore.net/page/${page}` });
        await settle(300);
        assert.ok(!restoredNote(tab), `page ${page} restored the history again`);
        assert.ok(remote.requests.slice(requests).every(request => request.body?.cursor !== 0),
            `page ${page} downloaded the whole history again`);
    }
    assert.ok(first);
});

const PROBE_KEY = 'javstore_storage_probe_v1';
const partKeys = store => [...store.data.keys()].filter(key => key.startsWith('javstore_part_'));

test('the device\'s size limit is measured across two page loads and then used', async () => {
    const store = makeStore({ maxEncodedValue: 30000 });
    await openTab(store, { html: listing() });
    await settle(100);
    assert.ok(store.read(PROBE_KEY)?.token, 'the first page starts a measurement');
    // A later page judges it; one opened within seconds would wait.
    const started = store.read(PROBE_KEY);
    store.write(PROBE_KEY, { ...started, startedAt: started.startedAt - 10000 });
    const second = await openTab(store, { html: listing() });
    await settle(100);
    assert.equal(store.read(PROBE_KEY).limit, 8000, '2 KB and 8 KB came back, 32 KB did not');
    assert.ok(![...store.data.keys()].some(key => key.startsWith('javstore_probe_')), 'probe values are removed');
    second.shadow().querySelector('.summary').click();
    assert.match(second.shadow().textContent, /storage keeps values up to 8 KB/);
});

test('with the limit measured, a large history is stored in parts that fit and survives', async () => {
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 30000 });
    store.write(PROBE_KEY, { limit: 8000, measuredAt: Date.now() });
    const remote = seeded(800);
    enableSync(store, remote);
    await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt, { timeout: 20000 });
    await settle(200);
    assert.equal(visitedUrls(store).length, 800);
    const parts = partKeys(store);
    assert.ok(parts.length > 1, 'the history is in parts');
    assert.ok(parts.every(key => encodeURIComponent(JSON.parse(store.data.get(key))).length <= 8000));
});

test('a value with a part missing is read as missing, not as a shorter history', async () => {
    const store = makeStore({ maxEncodedValue: 8000 });
    store.write(PROBE_KEY, { limit: 6000, measuredAt: Date.now() });
    const visited = {};
    for (let i = 0; i < 300; i++) visited[`https://javstore.net/v-${i}.html`] = Date.now() - 1000000 + i;
    // A main document in three parts, one of which never landed.
    const text = JSON.stringify({ version: 3, updatedAt: Date.now(), visited, settings: {} });
    const id = `${(Date.now() - 3600000).toString(36)}-test1`;
    const third = Math.ceil(text.length / 3);
    store.data.set(`javstore_part_${id}_0`, JSON.stringify(text.slice(0, third)));
    store.data.set(`javstore_part_${id}_2`, JSON.stringify(text.slice(2 * third)));
    store.data.set('javstore_cleanup_state_v2', JSON.stringify(JSON.stringify({ __jvsParts: 3, id, length: text.length })));
    const reader = await openTab(store, { html: listing() });
    await settle(50);
    reader.shadow().querySelector('.summary').click();
    assert.match(reader.shadow().textContent, /0 visited URLs stored/);
    assert.match(reader.shadow().textContent, /some stored values were missing parts/);
});

test('parts nothing refers to are removed once old, and parts in use are kept', async () => {
    const store = makeStore({ snapshotPerTab: true, maxEncodedValue: 30000 });
    store.write(PROBE_KEY, { limit: 8000, measuredAt: Date.now() });
    const old = (Date.now() - 2 * 3600000).toString(36);
    const recent = (Date.now() - 60000).toString(36);
    store.data.set(`javstore_part_${old}-orphan1_0`, JSON.stringify('x'));
    store.data.set(`javstore_part_${recent}-fresh1_0`, JSON.stringify('y'));
    const remote = seeded(600);
    enableSync(store, remote);
    await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt, { timeout: 20000 });
    await settle(200);
    // The next page loads after the parts the history uses were written.
    const inUse = partKeys(store).filter(key => !key.includes('orphan') && !key.includes('fresh'));
    assert.ok(inUse.length > 0);
    await openTab(store, { html: listing(), remote });
    await settle(200);
    assert.ok(!store.data.has(`javstore_part_${old}-orphan1_0`), 'an old orphan is removed');
    assert.ok(store.data.has(`javstore_part_${recent}-fresh1_0`), 'a recent one may still be in use elsewhere');
    assert.ok(inUse.every(key => store.data.has(key)), 'parts the history uses stay');
    assert.equal(visitedUrls(store).length, 600);
});

// Every stored value is handed to each page AdGuard loads, so the part sets a key used
// before must not pile up while a tab keeps saving.
test('saving again and again keeps at most two part sets per stored value', async () => {
    const store = makeStore({ maxEncodedValue: 8000 });
    store.write(PROBE_KEY, { limit: 6000, measuredAt: Date.now() });
    const remote = seeded(600);
    enableSync(store, remote);
    const tab = await openTab(store, { html: listingHtml(Array.from({ length: 12 }, (_, i) => [`/c-${i}.html`, `Card ${i}`])), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt, { timeout: 20000 });
    for (let i = 0; i < 12; i++) {
        tab.window.document.querySelector(`main .grid a[href="/c-${i}.html"]`)
            .dispatchEvent(new tab.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        await settle(30);
    }
    await settle(200);
    // Two per value stored in parts (the history, and this page's journal of what it pulled).
    const sets = new Set(partKeys(store).map(key => key.replace(/_\d+$/, '')));
    const parted = [...store.data.keys()].filter(key => !key.startsWith('javstore_part_')
        && JSON.parse(store.data.get(key)).includes?.('__jvsParts')).length;
    assert.ok(parted >= 1);
    assert.ok(sets.size <= 2 * parted, `${sets.size} part sets for ${parted} values`);
    assert.equal(visitedUrls(store).length, 612);
});
