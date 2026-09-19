import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeRemote, enableSync, openTab, closeTabs, settle, visitedUrls } from './harness.mjs';

afterEach(closeTabs);

// The two tiles from the report, exactly as the site serves them: raw Unicode in the
// path, with `。` already percent-encoded.
const RAW = [
    '/588346-FC2-PPV-4977211-限定✨初めてのローションで中までトロトロになっちゃった%E3%80%82白目向くほどイッちゃう-pn.html',
    '/588347-FC2-PPV-4979299-夢は小学校の先生%E3%80%82天使のような笑顔と色白美巨乳♡ほのぼの系美女のおじさま２人-pn.html',
];

const cardHtml = (href, title) =>
    `<a href="${href}"><div class="aspect-video"><img src="x.jpg"></div><h3>${title}</h3></a>`;
const listing = () => `<!doctype html><html><head></head><body><main><div class="grid">
    ${RAW.map((h, i) => cardHtml(h, `Tile ${i}`)).join('\n')}
</div></main></body></html>`;

const cards = window => [...window.document.querySelectorAll('main .grid a')];
const visitedFlags = window => cards(window).map(a => a.classList.contains('jvs-visited'));

test('the two reported tiles survive clicks, storage, sync and re-merges', async () => {
    const remote = makeRemote();
    const store = makeStore();
    enableSync(store, remote);

    const tab = await openTab(store, { html: listing(), url: 'https://javstore.net/', remote });
    await settle();

    cards(tab.window).forEach(a => a.dispatchEvent(
        new tab.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await settle();
    console.log('  after clicking   :', visitedFlags(tab.window));
    console.log('  keys on disk     :', visitedUrls(store).map(u => u.length + ' chars'));

    tab.shadow().querySelector('.sync-now').click();
    await settle();
    console.log('  on the worker    :', remote.visited().length, 'entries');
    console.log('  worker key lens  :', remote.visited().map(u => u.length));

    // Several more syncs and storage re-merges, which is what runs "after a while".
    for (let i = 0; i < 3; i += 1) {
        tab.shadow().querySelector('.sync-now').click();
        await settle();
        tab.window.dispatchEvent(new tab.window.Event('focus'));
        await settle();
    }
    console.log('  after re-merges  :', visitedFlags(tab.window));
    console.log('  still on disk    :', visitedUrls(store).length);

    // And a second device.
    const otherStore = makeStore();
    enableSync(otherStore, remote);
    const other = await openTab(otherStore, { html: listing(), url: 'https://javstore.net/', remote });
    await settle();
    console.log('  second device    :', visitedFlags(other.window));

    assert.deepEqual(visitedFlags(tab.window), [true, true], 'still visited on the first device');
    assert.equal(remote.visited().length, 2, 'both reached the worker');
    assert.deepEqual(visitedFlags(other.window), [true, true], 'visited on the second device');
});

test('the item page records the same key the listing tile uses', async () => {
    const store = makeStore();
    const listingTab = await openTab(store, { html: listing(), url: 'https://javstore.net/' });
    await settle();
    const fromTile = cards(listingTab.window)[0].href;
    listingTab.window.close();

    const itemTab = await openTab(store, {
        html: '<!doctype html><html><head></head><body><main><article><h1>Item</h1></article></main></body></html>',
        url: `https://javstore.net${RAW[0]}`,
    });
    await settle();
    const recorded = visitedUrls(store);
    console.log('  tile resolves to :', fromTile.slice(0, 80), '…', fromTile.length, 'chars');
    console.log('  page recorded    :', (recorded[0] || '').slice(0, 80), '…', (recorded[0] || '').length, 'chars');
    assert.deepEqual(recorded, [fromTile], 'the item page records exactly the tile key');
});
