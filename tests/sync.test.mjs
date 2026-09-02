import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/worker.mjs';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor,
    listingHtml, card, clickCard, pressOnCard, visitedUrls,
} from './harness.mjs';

const CARDS = [['/a.html', 'Alpha'], ['/b.html', 'Beta'], ['/c.html', 'Gamma']];
const listing = () => listingHtml(CARDS);

afterEach(closeTabs);

// Each store is one device's userscript-manager storage; they share only the worker.
async function openDevice(remote, { store = makeStore(), ...options } = {}) {
    enableSync(store, remote);
    const tab = await openTab(store, { html: listing(), remote, ...options });
    await settle();
    return tab;
}

function syncNow(tab) {
    tab.shadow().querySelector('.sync-now').click();
    return settle();
}

test('nothing is sent anywhere until sync is configured', async () => {
    const remote = makeRemote();
    const store = makeStore();
    const tab = await openTab(store, { html: listing(), remote });
    clickCard(tab.window, '/a.html');
    await settle();

    assert.deepEqual(remote.requests, []);
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('history recorded on one device reaches another through the worker', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    clickCard(first.window, '/a.html');
    await settle();
    await syncNow(first);
    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);

    const secondStore = makeStore();
    const second = await openDevice(remote, { store: secondStore });
    assert.ok(card(second.window, '/a.html').classList.contains('jvs-visited'));
    assert.deepEqual(visitedUrls(secondStore), ['https://javstore.net/a.html']);
});

test('a visit is pushed without being asked to sync', async () => {
    const remote = makeRemote();
    const tab = await openDevice(remote);
    clickCard(tab.window, '/b.html');
    await waitFor(() => remote.visited().includes('https://javstore.net/b.html'));
});

test('an item unmarked on one device does not come back from the cloud', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    clickCard(first.window, '/a.html');
    await settle();
    await syncNow(first);

    const secondStore = makeStore();
    const second = await openDevice(remote, { store: secondStore });
    assert.deepEqual(visitedUrls(secondStore), ['https://javstore.net/a.html']);

    pressOnCard(first.window, '/a.html', 'v');
    await settle();
    await syncNow(first);
    assert.deepEqual(remote.visited(), []);

    await syncNow(second);
    assert.deepEqual(visitedUrls(secondStore), []);
    assert.ok(!card(second.window, '/a.html').classList.contains('jvs-visited'));
});

test('clearing history on one device clears it everywhere', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    clickCard(first.window, '/a.html');
    clickCard(first.window, '/b.html');
    await settle();
    await syncNow(first);

    const secondStore = makeStore();
    const second = await openDevice(remote, { store: secondStore });
    assert.equal(visitedUrls(secondStore).length, 2);

    first.shadow().querySelector('.clear').click();
    await settle();
    await syncNow(first);
    assert.deepEqual(remote.visited(), []);

    await syncNow(second);
    assert.deepEqual(visitedUrls(secondStore), []);
});

test('a device that has been offline cannot overwrite what the others recorded', async () => {
    const remote = makeRemote();
    const staleStore = makeStore();
    const stale = await openDevice(remote, { store: staleStore });

    const otherStore = makeStore();
    const other = await openDevice(remote, { store: otherStore });
    clickCard(other.window, '/b.html');
    await settle();
    await syncNow(other);

    // The stale device never saw /b.html, and still pushes its own whole document.
    clickCard(stale.window, '/a.html');
    await settle();
    await syncNow(stale);

    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html', 'https://javstore.net/b.html']);
    assert.deepEqual(visitedUrls(staleStore), ['https://javstore.net/a.html', 'https://javstore.net/b.html']);
});

test('settings changed on one device follow to another', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    const form = first.shadow().querySelector('form.settings-form');
    form.elements.mode.value = 'blur';
    form.dispatchEvent(new first.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    await syncNow(first);

    const second = await openDevice(remote, { store: makeStore() });
    assert.equal(second.shadow().querySelector('form.settings-form').elements.mode.value, 'blur');
});

test('an empty worker does not reset a device to the default settings', async () => {
    const remote = makeRemote();
    const store = makeStore();
    const tab = await openTab(store, { html: listing() });
    const form = tab.shadow().querySelector('form.settings-form');
    form.elements.mode.value = 'hide';
    form.dispatchEvent(new tab.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    enableSync(store, remote);
    const synced = await openTab(store, { html: listing(), remote });
    await settle();
    assert.equal(synced.shadow().querySelector('form.settings-form').elements.mode.value, 'hide');
    assert.equal(remote.state().settings.mode, 'hide');
});

test('the endpoint and token never enter the synced document', async () => {
    const remote = makeRemote({ token: 'super-secret-token' });
    const store = makeStore();
    const tab = await openDevice(remote, { store });
    clickCard(tab.window, '/a.html');
    await settle();
    await syncNow(tab);

    const pushed = JSON.stringify(remote.requests.at(-1).body);
    const stored = JSON.stringify(remote.state());
    const local = JSON.stringify(store.state());
    assert.ok(!stored.includes('super-secret-token'));
    assert.ok(!local.includes('super-secret-token'));
    assert.ok(!stored.includes(remote.endpoint));
    assert.ok(!local.includes(remote.endpoint));
    // The token is only ever a request header.
    assert.ok(!pushed.includes('super-secret-token'));
    assert.equal(remote.requests.at(-1).headers.Authorization, 'Bearer super-secret-token');
});

test('a worker outage leaves local history intact and is reported', async () => {
    const remote = makeRemote();
    const store = makeStore();
    remote.offline = true;
    const tab = await openDevice(remote, { store });

    clickCard(tab.window, '/a.html');
    await settle();
    await syncNow(tab);
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
    assert.match(tab.shadow().querySelector('.counts').textContent, /sync failed/);

    remote.offline = false;
    await syncNow(tab);
    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
    assert.match(tab.shadow().querySelector('.counts').textContent, /synced/);
});

test('sync can be turned on from the panel and is remembered', async () => {
    const remote = makeRemote();
    const store = makeStore();
    const tab = await openTab(store, { html: listing(), remote });
    clickCard(tab.window, '/a.html');
    await settle();
    assert.deepEqual(remote.requests, []);

    const form = tab.shadow().querySelector('form.sync-form');
    form.elements.syncEnabled.checked = true;
    form.elements.syncEndpoint.value = remote.endpoint;
    form.elements.syncToken.value = remote.token;
    form.dispatchEvent(new tab.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
    assert.equal(JSON.parse(store.data.get('javstore_sync_config_v1')).endpoint, remote.endpoint);

    // A later page load picks the configuration back up on its own.
    const reloaded = await openTab(store, { html: listing(), remote });
    await settle();
    assert.equal(reloaded.shadow().querySelector('form.sync-form').elements.syncEnabled.checked, true);
    assert.match(reloaded.shadow().querySelector('.counts').textContent, /synced/);
});

test('an http endpoint that is not loopback is refused', async () => {
    const remote = makeRemote();
    const store = makeStore();
    const tab = await openTab(store, { html: listing(), remote });

    const form = tab.shadow().querySelector('form.sync-form');
    form.elements.syncEnabled.checked = true;
    form.elements.syncEndpoint.value = 'http://sync.example.com/state';
    form.elements.syncToken.value = 'token';
    form.dispatchEvent(new tab.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    assert.match(tab.shadow().querySelector('.toast').textContent, /https/);
    assert.deepEqual(remote.requests, []);
    assert.equal(store.data.get('javstore_sync_config_v1'), undefined);
});

test('a sync with nothing new sends and receives nothing', async () => {
    const remote = makeRemote();
    const tab = await openDevice(remote);
    clickCard(tab.window, '/a.html');
    await settle();
    await syncNow(tab);

    const rowsBefore = remote.rows().length;
    await syncNow(tab);
    assert.deepEqual(remote.lastPushedChanges(), [], 'nothing to push');
    assert.equal(remote.rows().length, rowsBefore, 'nothing new stored');
    // The whole point of the delta protocol: an idle sync is a few hundred bytes.
    assert.ok(JSON.stringify(remote.requests.at(-1).body).length < 1000);

    await syncNow(tab);
    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
});

test('the cursor does not move past history that could not be saved', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    clickCard(first.window, '/a.html');
    await settle();
    await syncNow(first);

    // The pull succeeds but storage refuses the merged history, so the device is still
    // missing /a.html once the tab is gone.
    const secondStore = makeStore();
    secondStore.dropStateWrites = true;
    await openDevice(remote, { store: secondStore });
    await waitFor(() => remote.requests.length > 0);
    // Long enough for the write to be retried and given up on.
    await settle(600);
    assert.equal(secondStore.state(), null, 'precondition: the history never landed');
    assert.ok(
        !JSON.parse(secondStore.data.get('javstore_sync_config_v1')).cursor,
        'a cursor recorded here would skip the rows that were lost',
    );

    // Reopening the device is the reload after the failed write: the rows have to come
    // down again.
    closeTabs();
    secondStore.dropStateWrites = false;
    await openDevice(remote, { store: secondStore });
    await waitFor(() => visitedUrls(secondStore).length === 1);
    assert.deepEqual(visitedUrls(secondStore), ['https://javstore.net/a.html']);
});

test('a merge that only brings back a tombstone is still saved', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    clickCard(first.window, '/a.html');
    await settle();
    await syncNow(first);
    pressOnCard(first.window, '/a.html', 'v');
    await settle();
    await syncNow(first);

    // This device has never seen /a.html, so the visit and the deletion that follows it
    // cancel out: nothing on screen changes, but the tombstone that keeps the visit from
    // coming back has to survive the reload the cursor was recorded for.
    const secondStore = makeStore();
    await openDevice(remote, { store: secondStore });
    await waitFor(() => secondStore.state());
    assert.deepEqual(visitedUrls(secondStore), []);
    assert.ok(
        secondStore.state().tombstones['v|https://javstore.net/a.html'],
        'the tombstone reached storage',
    );
    assert.ok(JSON.parse(secondStore.data.get('javstore_sync_config_v1')).cursor > 0);
});

test('pointing the panel at a different worker starts over', async () => {
    const first = makeRemote({ origin: 'https://one.test' });
    const second = makeRemote({ origin: 'https://two.test' });
    second.token = first.token;
    second.env.SYNC_TOKEN = first.token;

    const store = makeStore();
    enableSync(store, first);
    const tab = await openTab(store, { html: listing(), remote: [first, second] });
    await settle();
    clickCard(tab.window, '/a.html');
    await settle();
    await syncNow(tab);
    assert.ok(JSON.parse(store.data.get('javstore_sync_config_v1')).cursor > 0);

    const form = tab.shadow().querySelector('form.sync-form');
    form.elements.syncEndpoint.value = second.endpoint;
    form.dispatchEvent(new tab.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    // The cursor from the old worker means nothing here, so the history goes up in full.
    assert.deepEqual(second.visited(), ['https://javstore.net/a.html']);
});

test('only what changed since the last push goes up', async () => {
    const remote = makeRemote();
    const tab = await openDevice(remote);
    clickCard(tab.window, '/a.html');
    clickCard(tab.window, '/b.html');
    await settle();
    await syncNow(tab);
    assert.equal(remote.lastPushedChanges().length, 2);

    clickCard(tab.window, '/c.html');
    await settle();
    await syncNow(tab);
    const pushed = remote.lastPushedChanges();
    assert.equal(pushed.length, 1, 'the two already-synced visits are not sent again');
    assert.equal(pushed[0].key, 'https://javstore.net/c.html');
});

test('a device pulls only what it has not seen', async () => {
    const remote = makeRemote();
    const first = await openDevice(remote);
    clickCard(first.window, '/a.html');
    await settle();
    await syncNow(first);

    const secondStore = makeStore();
    const second = await openDevice(remote, { store: secondStore });
    assert.deepEqual(visitedUrls(secondStore), ['https://javstore.net/a.html']);

    clickCard(first.window, '/b.html');
    await settle();
    await syncNow(first);

    await syncNow(second);
    const pulled = JSON.parse(
        (await remote.handle({
            method: 'POST',
            url: remote.endpoint,
            headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cursor: 0, meta: {}, changes: [] }),
        })).text,
    );
    assert.equal(pulled.changes.length, 2, 'a cursor of zero still gets the whole history');
    assert.deepEqual(visitedUrls(secondStore).sort(), [
        'https://javstore.net/a.html',
        'https://javstore.net/b.html',
    ]);
});

test('the stored token is not left anywhere the site can read it', async () => {
    const remote = makeRemote({ token: 'panel-secret' });
    const store = makeStore();
    enableSync(store, remote);
    const tab = await openTab(store, { html: listing(), remote });
    await settle();
    tab.shadow().querySelector('.summary').click();
    await settle();

    const field = tab.shadow().querySelector('[name="syncToken"]');
    assert.equal(field.value, '');
    assert.match(field.placeholder, /Stored/);
    assert.ok(!tab.shadow().innerHTML.includes('panel-secret'));

    // Saving with the box left empty keeps the stored token rather than clearing it.
    tab.shadow().querySelector('form.sync-form')
        .dispatchEvent(new tab.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(JSON.parse(store.data.get('javstore_sync_config_v1')).token, 'panel-secret');
});

test('a backup taken from the worker imports back into the panel', async () => {
    const remote = makeRemote();
    const source = await openDevice(remote);
    clickCard(source.window, '/a.html');
    await settle();
    await syncNow(source);

    const response = await worker.fetch(new Request(remote.endpoint, {
        headers: { Authorization: `Bearer ${remote.token}` },
    }), remote.env);
    const backup = await response.text();

    const store = makeStore();
    const tab = await openTab(store, { html: listing() });
    const input = tab.shadow().querySelector('.import-file');
    Object.defineProperty(input, 'files', { value: [{ text: async () => backup }] });
    input.dispatchEvent(new tab.window.Event('change', { bubbles: true }));
    await settle();

    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
});

test('a userscript manager that refuses the request falls back to fetch', async () => {
    const remote = makeRemote();
    remote.blockGm = true;

    const store = makeStore();
    const tab = await openDevice(remote, { store });
    clickCard(tab.window, '/a.html');
    await settle();
    await syncNow(tab);

    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
    assert.match(tab.shadow().querySelector('.counts').textContent, /synced/);
});

test('a worker that cannot be reached either way reports the refusal', async () => {
    const remote = makeRemote();
    remote.blockGm = true;
    remote.offline = true;

    const tab = await openDevice(remote);
    await syncNow(tab);
    assert.match(tab.shadow().querySelector('.counts').textContent, /could not be reached \(Forbidden\)/);
});

test('the worker refuses a request without the right token', async () => {
    const remote = makeRemote({ token: 'right' });
    const body = JSON.stringify({ state: { visited: { 'https://javstore.net/a.html': Date.now() } } });

    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer righ' }]) {
        const response = await worker.fetch(
            new Request(remote.endpoint, { method: 'POST', headers, body }),
            remote.env,
        );
        assert.equal(response.status, 401);
    }
    assert.deepEqual(remote.rows(), [], 'nothing was stored');

    const allowed = await worker.fetch(
        new Request(remote.endpoint, { method: 'POST', headers: { Authorization: 'Bearer right' }, body }),
        remote.env,
    );
    assert.equal(allowed.status, 200);
    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
});

test('the worker keeps the newest timestamp and honours tombstones', async () => {
    const remote = makeRemote();
    const sync = payload => remote.store.sync(payload, 1000);

    sync({ cursor: 0, changes: [{ kind: 'v', key: '/a', at: 100 }, { kind: 'v', key: '/b', at: 500 }] });
    sync({
        cursor: 0,
        changes: [
            { kind: 'v', key: '/a', at: 400 },
            { kind: 'v', key: '/b', at: 200 },
            { kind: 'v', key: '/c', at: 300 },
            { kind: 'v', key: '/c', at: 300, deleted: 1 },
        ],
    });

    const document = remote.state();
    assert.deepEqual(document.visited, { '/a': 400, '/b': 500 });
    assert.equal(document.tombstones['v|/c'], 300);
});

test('a device that is behind is told the winning entry it missed', async () => {
    const remote = makeRemote();
    remote.store.sync({ cursor: 0, changes: [{ kind: 'v', key: '/a', at: 500 }] });

    // A stale device pushes an older timestamp for the same URL.
    const answer = remote.store.sync({ cursor: 99, changes: [{ kind: 'v', key: '/a', at: 100 }] });
    assert.deepEqual(answer.changes, [{ kind: 'v', key: '/a', at: 500, deleted: 0 }]);
    assert.equal(remote.state().visited['/a'], 500);
});

test('a worker still running the document-only version keeps working', async () => {
    const remote = makeRemote();
    const legacy = {
        async handle({ url, headers, body }) {
            remote.requests.push({ url, headers, body: JSON.parse(body) });
            // The 6.2.0 worker answered every POST with the whole document.
            const parsed = JSON.parse(body);
            if (parsed.state) {
                // The 6.2.0 worker merged rather than replaced.
                legacy.document = {
                    ...legacy.document,
                    ...parsed.state,
                    visited: { ...legacy.document.visited, ...parsed.state.visited },
                };
            }
            return { status: 200, statusText: '', text: JSON.stringify({ state: legacy.document }) };
        },
        document: {
            version: 3,
            updatedAt: Date.now(),
            visited: { 'https://javstore.net/c.html': Date.now() },
        },
        endpoint: remote.endpoint,
        token: remote.token,
        offline: false,
        requests: remote.requests,
    };

    const store = makeStore();
    enableSync(store, legacy);
    const tab = await openTab(store, { html: listing(), remote: legacy });
    await settle();
    clickCard(tab.window, '/a.html');
    await settle();
    tab.shadow().querySelector('.sync-now').click();
    await settle();

    assert.ok(card(tab.window, '/c.html').classList.contains('jvs-visited'), 'pulled from the old worker');
    assert.ok(
        Object.keys(legacy.document.visited).includes('https://javstore.net/a.html'),
        'and still pushed to it',
    );
});

test('the worker answers a plain GET with the whole document', async () => {
    const remote = makeRemote();
    await worker.fetch(new Request(remote.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${remote.token}` },
        body: JSON.stringify({ cursor: 0, changes: [{ kind: 'v', key: '/a', at: 10 }] }),
    }), remote.env);

    const response = await worker.fetch(new Request(remote.endpoint, {
        headers: { Authorization: `Bearer ${remote.token}` },
    }), remote.env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).state.visited, { '/a': 10 });
});

test('a history left behind in the KV namespace is imported once', async () => {
    const at = Date.now();
    const remote = makeRemote({
        legacyDocument: {
            version: 3,
            updatedAt: at,
            settingsUpdatedAt: at,
            settings: { mode: 'blur' },
            visited: { 'https://javstore.net/a.html': at },
        },
    });

    const store = makeStore();
    const tab = await openDevice(remote, { store });
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/a.html']);
    assert.ok(card(tab.window, '/a.html').classList.contains('jvs-visited'));
    assert.equal(tab.shadow().querySelector('form.settings-form').elements.mode.value, 'blur');
});
