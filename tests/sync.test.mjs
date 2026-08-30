import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { mergeDocuments } from '../worker/src/worker.mjs';
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

test('a sync with nothing new does not write to the namespace', async () => {
    const remote = makeRemote();
    const tab = await openDevice(remote);
    clickCard(tab.window, '/a.html');
    await settle();
    await syncNow(tab);

    const writes = remote.kv.writes;
    await syncNow(tab);
    await syncNow(tab);
    assert.equal(remote.kv.writes, writes, 'a sync that changes nothing should not store anything');
    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
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
    assert.equal(remote.state(), null);

    const allowed = await worker.fetch(
        new Request(remote.endpoint, { method: 'POST', headers: { Authorization: 'Bearer right' }, body }),
        remote.env,
    );
    assert.equal(allowed.status, 200);
    assert.deepEqual(remote.visited(), ['https://javstore.net/a.html']);
});

test('the worker keeps the newest timestamp and honours tombstones', async () => {
    const merged = mergeDocuments(
        {
            updatedAt: 100,
            visited: { '/a': 100, '/b': 500 },
            tombstones: {},
        },
        {
            updatedAt: 200,
            visited: { '/a': 400, '/b': 200, '/c': 300 },
            tombstones: { 'v|/c': 300 },
        },
        1000,
    );

    assert.deepEqual(merged.visited, { '/a': 400, '/b': 500 });
    assert.equal(merged.tombstones['v|/c'], 300);
});

test('the worker answers a plain GET with the stored document', async () => {
    const remote = makeRemote();
    await worker.fetch(new Request(remote.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${remote.token}` },
        body: JSON.stringify({ state: { updatedAt: 10, visited: { '/a': 10 } } }),
    }), remote.env);

    const response = await worker.fetch(new Request(remote.endpoint, {
        headers: { Authorization: `Bearer ${remote.token}` },
    }), remote.env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).state.visited, { '/a': 10 });
});
