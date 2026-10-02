import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, openTab, closeTabs, listingHtml, settle, clickCard, visitedUrls,
    openInNewTabFromContextMenu,
} from './harness.mjs';

afterEach(closeTabs);

test('repairs item-title hashes without double encoding or losing URL suffixes', async () => {
    const cases = [
        ['/590733-Title(23)#6-example-pn.html', '/590733-Title(23)%236-example-pn.html'],
        ['590733-%E6%96%B0(23)#6-pn.html', '/590733-%E6%96%B0(23)%236-pn.html'],
        ['https://javstore.net/590733-Title#6-pn.html', '/590733-Title%236-pn.html'],
        ['//javstore.net/590733-Title#6#7-pn.html', '/590733-Title%236%237-pn.html'],
        ['/590733-Title#6-pn.html?mode=full#comments', '/590733-Title%236-pn.html?mode=full#comments'],
        ['/590733-Title#6-pn.html#comments', '/590733-Title%236-pn.html#comments'],
    ];
    const tab = await openTab(makeStore(), { html: listingHtml(cases.map(([url]) => [url, 'Item'])) });
    const links = [...tab.window.document.querySelectorAll('main .grid a')];
    assert.deepEqual(links.map(link => link.href), cases.map(([, expected]) => `https://javstore.net${expected}`));
    await settle();
    assert.deepEqual(links.map(link => link.href), cases.map(([, expected]) => `https://javstore.net${expected}`));
    assert.equal(openInNewTabFromContextMenu(tab.window, links[0].getAttribute('href')).hash, '');
});

test('preserves legitimate fragments, encoded paths, unrelated hosts and ambiguous links', async () => {
    const urls = [
        '/590733-Title-pn.html#comments', '/590733-Title-pn.html#other-pn.html',
        '/590733-Title%236-pn.html?x=1#comments', '#comments',
        '/590733-Title#comments', '/590733-Title#6.html',
        '/590733-Title?next=x#6-pn.html', '/search#6-pn.html',
        '/folder/590733-Title#6-pn.html', '/590733-Title#folder/file-pn.html',
        'https://example.com/590733-Title#6-pn.html',
        'https://javstore.net.example.com/590733-Title#6-pn.html',
        'ftp://javstore.net/590733-Title#6-pn.html',
    ];
    const tab = await openTab(makeStore(), { html: listingHtml(urls.map(url => [url, 'Item'])) });
    assert.deepEqual([...tab.window.document.querySelectorAll('main .grid a')].map(link => link.getAttribute('href')), urls);
});

test('repairs added and changed tiles and records the repaired destination in history', async () => {
    const store = makeStore();
    const tab = await openTab(store);
    const grid = tab.window.document.querySelector('main .grid');
    grid.innerHTML = '<a href="/590733-Title#6-pn.html"><div class="aspect-video"><img></div><h3>Item</h3></a>';
    await settle();
    const link = grid.querySelector('a');
    assert.equal(link.href, 'https://javstore.net/590733-Title%236-pn.html');
    link.setAttribute('href', '/590733-Title#7-pn.html?view=full#comments');
    await settle();
    assert.equal(link.href, 'https://javstore.net/590733-Title%237-pn.html?view=full#comments');
    clickCard(tab.window, link.getAttribute('href'));
    await settle();
    assert.deepEqual(visitedUrls(store), ['https://javstore.net/590733-Title%237-pn.html']);
});

test('existing visits to the correct URL still mark repaired tiles as visited', async () => {
    const store = makeStore();
    const first = await openTab(store, { html: listingHtml([
        ['/590733-Title%236-pn.html', 'Item'],
        ['/590734-Other-pn.html#comments', 'Other'],
    ]) });
    clickCard(first.window, '/590733-Title%236-pn.html');
    clickCard(first.window, '/590734-Other-pn.html#comments');
    await settle();
    const reloaded = await openTab(store, { html: listingHtml([
        ['/590733-Title#6-pn.html', 'Item'],
        ['/590734-Other-pn.html#comments', 'Other'],
    ]) });
    const links = [...reloaded.window.document.querySelectorAll('main .grid a')];
    assert.ok(links.every(link => link.classList.contains('jvs-visited')));
    assert.deepEqual(visitedUrls(store), [
        'https://javstore.net/590733-Title%236-pn.html',
        'https://javstore.net/590734-Other-pn.html',
    ]);
});
