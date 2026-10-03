import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, openTab, closeTabs, listingHtml, waitFor } from './harness.mjs';

afterEach(closeTabs);
const url = 'https://javstore.net/590733-Item-pn.html';
const html = listingHtml([[url, 'Item']]);

function seededStore() {
    const store = makeStore();
    store.write('javstore_cleanup_state_v2', {
        visited: { [url]: Date.now() - 1000 },
        settings: { keywords: ['Item'], mode: 'tint' },
    });
    return store;
}

for (const blocked of ['config', 'journals']) {
    test(`paints local tiles while ${blocked} storage is pending, then reconciles recovery`, async () => {
        const store = seededStore();
        const at = Date.now();
        store.write('javstore_journal_v1_startup', {
            visited: { 'https://javstore.net/recovered.html': at },
            settings: { keywords: ['Different'], mode: 'tint' },
            settingsUpdatedAt: at,
        });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const get = store.get.bind(store);
        const list = store.list.bind(store);
        if (blocked === 'config') store.get = async (key, fallback) => {
            if (key === 'javstore_sync_config_v1') await gate;
            return get(key, fallback);
        };
        else store.list = async () => { await gate; return list(); };
        let writes = 0;
        const set = store.set.bind(store);
        store.set = (...args) => { writes++; return set(...args); };
        try {
            const tab = await openTab(store, { html });
            const tile = tab.window.document.querySelector('main .grid a');
            await waitFor(() => tile.classList.contains('jvs-mode-tint'));
            assert.ok(tile.classList.contains('jvs-visited'));
            assert.equal(writes, 0, 'preview must not write before recovery is read');
            release();
            await waitFor(() => !tile.classList.contains('jvs-mode-tint'));
            await waitFor(() => store.state()?.visited?.['https://javstore.net/recovered.html']);
        } finally { release(); }
    });
}

test('processes visible and newly inserted tiles before DOMContentLoaded', async () => {
    const tab = await openTab(seededStore(), {
        html,
        beforeRun(window) {
            Object.defineProperty(window.document, 'readyState', { configurable: true, get: () => 'loading' });
        },
    });
    const tile = tab.window.document.querySelector('main .grid a');
    await waitFor(() => tile.classList.contains('jvs-visited'));
    assert.ok(tile.classList.contains('jvs-mode-tint'));
    const added = tile.cloneNode(true);
    added.className = '';
    tile.parentElement.append(added);
    await waitFor(() => added.classList.contains('jvs-visited'));
    assert.ok(added.classList.contains('jvs-mode-tint'));
    tab.window.document.dispatchEvent(new tab.window.Event('DOMContentLoaded'));
    await waitFor(() => tab.window.document.getElementById('jvs-controls-host'));
});
