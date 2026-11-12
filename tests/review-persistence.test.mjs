// Review: local history under AdGuard's per-tab storage snapshots.
//
// AdGuard hands every tab the GM storage it had when the tab loaded, plus that tab's own
// writes; a tab never sees what another tab writes after it loaded. These tests open a
// long-lived "old" tab, make changes in tabs opened later, let ten minutes pass (the
// journal TTL), and then let the old tab save once. A fresh tab must still see every
// change the newer tabs made.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, openTab, closeTabs, settle, listingHtml, detailHtml, card, clickCard,
    pressOnCard, visitedUrls,
} from './harness.mjs';

const CARDS = [['/a.html', 'Alpha'], ['/b.html', 'Beta'], ['/c.html', 'Gamma'], ['/d.html', 'Delta']];
const listing = () => listingHtml(CARDS);
const u = href => `https://javstore.net${href}`;
const TTL_PLUS = 11 * 60000;

afterEach(closeTabs);

// One clock for every tab of the device, which a test can move forward.
function device(options = {}) {
    const store = makeStore({ snapshotPerTab: true, ...options });
    const clock = { offset: 0 };
    const open = (extra = {}) => openTab(store, {
        html: listing(),
        ...extra,
        beforeRun: window => {
            const realNow = window.Date.now.bind(window.Date);
            window.Date.now = () => realNow() + clock.offset;
        },
    });
    return { store, clock, open };
}

const isVisited = (tab, href) => card(tab.window, href).classList.contains('jvs-visited');

test('review: a visit recorded after a long-open tab loaded survives that tab saving once journals age out', async () => {
    const { store, clock, open } = device();
    const old = await open();
    await open({ html: detailHtml, url: u('/b.html') });
    await settle();
    assert.deepEqual(visitedUrls(store), [u('/b.html')]);

    clock.offset = TTL_PLUS;
    const newer = await open();
    clickCard(newer.window, '/c.html');
    await settle();
    assert.deepEqual(visitedUrls(store), [u('/b.html'), u('/c.html')]);

    clickCard(old.window, '/a.html');
    await settle();

    const fresh = await open();
    await settle();
    assert.ok(isVisited(fresh, '/b.html'), 'b was recorded by a tab opened after the old one');
    assert.ok(isVisited(fresh, '/c.html'));
    assert.ok(isVisited(fresh, '/a.html'));
});

test('review: a long-open tab does not delete a journal its owner rewrote after the tab loaded', async () => {
    const { store, clock, open } = device();
    const owner = await open();
    clickCard(owner.window, '/a.html');
    await settle();
    const [ownerJournal] = store.journals();
    assert.ok(ownerJournal);

    // Loaded after the owner's first save, so its snapshot holds that copy of the journal.
    const stale = await open();
    clock.offset = TTL_PLUS;
    // Only the owner records b (a manual mark; a click whose item tab never loaded). The
    // owner is itself long-open by now, so b goes to its journal, which has moved on to a
    // new key that carries everything the old one did.
    pressOnCard(owner.window, '/b.html', 'v');
    await settle();
    const holdsB = () => store.journals().some(key => store.read(key)?.visited?.[u('/b.html')]);
    assert.ok(holdsB(), 'the owner journal carries b');

    clickCard(stale.window, '/c.html');
    await settle();
    assert.ok(holdsB(), 'the stale tab left the owner journal alone');

    const fresh = await open();
    await settle();
    assert.ok(isVisited(fresh, '/b.html'));
});

test('review: "Clear visited history" in a newer tab is not undone by a long-open tab', async () => {
    const { store, clock, open } = device();
    const seeded = await open();
    clickCard(seeded.window, '/a.html');
    clickCard(seeded.window, '/b.html');
    await settle();

    const old = await open();
    const clearing = await open();
    clearing.shadow().querySelector('.clear').click();
    await settle();
    assert.deepEqual(visitedUrls(store), []);

    clock.offset = TTL_PLUS;
    const later = await open();
    clickCard(later.window, '/d.html');
    await settle();
    clickCard(old.window, '/c.html');
    await settle();

    const fresh = await open();
    await settle();
    assert.ok(!isVisited(fresh, '/a.html'), 'a was cleared');
    assert.ok(!isVisited(fresh, '/b.html'), 'b was cleared');
});

test('review: an item unmarked in a newer tab is not resurrected by a long-open tab', async () => {
    const { clock, open } = device();
    const seeded = await open();
    clickCard(seeded.window, '/a.html');
    await settle();

    const old = await open();
    const unmarking = await open();
    pressOnCard(unmarking.window, '/a.html', 'v');
    await settle();

    clock.offset = TTL_PLUS;
    const later = await open();
    clickCard(later.window, '/d.html');
    await settle();
    clickCard(old.window, '/c.html');
    await settle();

    const fresh = await open();
    await settle();
    assert.ok(!isVisited(fresh, '/a.html'));
});

test('review: a setting changed in a newer tab is not reverted by a long-open tab', async () => {
    const { clock, open } = device();
    const old = await open();
    const changing = await open();
    const form = changing.shadow().querySelector('form.settings-form');
    form.elements.mode.value = 'blur';
    form.dispatchEvent(new changing.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    clock.offset = TTL_PLUS;
    const later = await open();
    clickCard(later.window, '/d.html');
    await settle();
    clickCard(old.window, '/c.html');
    await settle();

    const fresh = await open();
    await settle();
    assert.equal(fresh.shadow().querySelector('form.settings-form').elements.mode.value, 'blur');
});

test('review: a per-card override set in a newer tab is not dropped by a long-open tab', async () => {
    const { store, clock, open } = device();
    const old = await open();
    const overriding = await open();
    pressOnCard(overriding.window, '/a.html', 'o');
    await settle();
    assert.equal(store.state().overrides[u('/a.html')], 'allow');

    clock.offset = TTL_PLUS;
    const later = await open();
    clickCard(later.window, '/d.html');
    await settle();
    clickCard(old.window, '/c.html');
    await settle();

    const fresh = await open();
    await settle();
    assert.ok(card(fresh.window, '/a.html'), 'fresh tab loaded');
    assert.equal(store.state().overrides[u('/a.html')], 'allow');
});

// Not snapshot-specific: the import deletes this device's tombstone for a restored URL in
// memory, then its own save merges the stored tombstone straight back over the restored
// (older) visit.
test('review: importing a backup restores a visit that was unmarked after the backup was taken', async () => {
    const store = makeStore();
    const backupAt = Date.now() - 86400000;
    const tab = await openTab(store, { html: listing() });
    clickCard(tab.window, '/a.html');
    await settle();
    pressOnCard(tab.window, '/a.html', 'v');
    await settle();
    assert.deepEqual(visitedUrls(store), []);

    const input = tab.shadow().querySelector('.import-file');
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [{
            text: async () => JSON.stringify({
                version: 3, updatedAt: backupAt, visited: { [u('/a.html')]: backupAt },
                overrides: {}, overrideTimes: {}, tombstones: {},
            }),
        }],
    });
    input.dispatchEvent(new tab.window.Event('change'));
    await settle();
    assert.ok(isVisited(tab, '/a.html'), 'the importing tab shows it restored');
    assert.deepEqual(visitedUrls(store), [u('/a.html')], 'and storage keeps it');
});

// The 6.5.0 scenario (Ctrl-click bursts on slow storage) under the per-tab snapshot model.
test('review: a burst of Ctrl-clicks on slow snapshot-per-tab storage loses nothing', async () => {
    const TILES = Array.from({ length: 8 }, (_, index) => [`/t-${index}.html`, `Tile ${index}`]);
    const store = makeStore({ latency: 150, snapshotPerTab: true });
    const opening = [];
    const listingTab = await openTab(store, { html: listingHtml(TILES) });
    for (const [href] of TILES) {
        clickCard(listingTab.window, href);
        opening.push(openTab(store, { html: detailHtml, url: u(href) }));
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    await Promise.all(opening);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const reloaded = await openTab(store, { html: listingHtml(TILES) });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const unmarked = TILES.map(([href]) => href)
        .filter(href => !card(reloaded.window, href).classList.contains('jvs-visited'));
    assert.deepEqual(unmarked, []);
    await new Promise(resolve => setTimeout(resolve, 2000));
});
