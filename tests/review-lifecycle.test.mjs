// Design review: page lifecycle, many long-open tabs, and cost per page on a storage
// engine that behaves like AdGuard's (a snapshot per tab, asynchronous GM calls).
//
// Tests marked `todo` demonstrate a problem: they assert the behaviour the script should
// have and currently fail, without failing the suite. The `measure:` tests report numbers
// through diagnostics (visible with --test-reporter=spec) and only assert loose bounds.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeStore, makeRemote, enableSync, openTab, closeTabs, settle, waitFor,
    listingHtml, detailHtml, card, clickCard, pressOnCard, visitedUrls,
} from './harness.mjs';

const STATE_KEY = 'javstore_cleanup_state_v2';
const SESSION_KEY = 'javstore_sync_session_v1';
const CONFIG_KEY = 'javstore_sync_config_v1';
const CARDS = [['/a.html', 'Alpha'], ['/b.html', 'Beta'], ['/c.html', 'Gamma']];
const listing = () => listingHtml(CARDS);
const abs = href => `https://javstore.net${href}`;
const TTL = 10 * 60000;

afterEach(closeTabs);

function closeTab(tab) {
    tab.window.dispatchEvent(new tab.window.Event('pagehide'));
    tab.window.close();
}

// Pushes a journal's last write into the past, the way it looks once JOURNAL_TTL_MS has
// gone by without its page writing again.
function age(store, key, ms = TTL + 60000) {
    const journal = store.read(key);
    journal.writtenAt -= ms;
    store.write(key, journal);
}

// A history the size the cap allows: 5,000 visits and 2,000 tombstones, with item URLs of
// the length the site uses.
function bigHistory(now = Date.now()) {
    const visited = {};
    const tombstones = {};
    for (let i = 0; i < 5000; i++) {
        visited[`https://javstore.net/${600000 + i}-FC2-PPV-${3000000 + i}-Some-Typical-Title-Words-pn.html`] = now - 86400000 + i;
    }
    for (let i = 0; i < 2000; i++) {
        tombstones[`v|https://javstore.net/${500000 + i}-FC2-PPV-${2000000 + i}-Some-Typical-Title-Words-pn.html`] = now - 3600000 + i;
    }
    return {
        version: 3, updatedAt: now - 1000, settingsUpdatedAt: 0, settingTimes: {},
        resetAt: 0, prunedBefore: 0, settings: {}, visited, overrides: {}, overrideTimes: {}, tombstones,
    };
}

// Counts GM calls and the bytes they move. Only valid for a store without snapshotPerTab
// (a snapshot view reads from its own copy).
function meter(store) {
    const counts = { get: 0, set: 0, list: 0, delete: 0, readBytes: 0, writeBytes: 0, mainReads: 0, mainWrites: 0, sessionWrites: 0 };
    const original = { get: store.get, set: store.set, list: store.list, delete: store.delete };
    store.get = async function (key, fallback) {
        counts.get++;
        if (key === STATE_KEY) counts.mainReads++;
        const value = await original.get.call(this, key, fallback);
        if (typeof value === 'string') counts.readBytes += value.length;
        return value;
    };
    store.set = async function (key, value) {
        counts.set++;
        if (key === STATE_KEY) counts.mainWrites++;
        if (key === SESSION_KEY) counts.sessionWrites++;
        counts.writeBytes += typeof value === 'string' ? value.length : JSON.stringify(value).length;
        return original.set.call(this, key, value);
    };
    store.list = async function () { counts.list++; return original.list.call(this); };
    store.delete = async function (key) { counts.delete++; return original.delete.call(this, key); };
    const snapshot = () => ({ ...counts });
    const since = before => Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - before[key]]));
    return { counts, snapshot, since };
}

const kb = bytes => `${(bytes / 1024).toFixed(0)} KB`;
const describe = c => `GM get ${c.get} (main ${c.mainReads}), set ${c.set} (main ${c.mainWrites}), list ${c.list}, delete ${c.delete}; read ${kb(c.readBytes)}, wrote ${kb(c.writeBytes)}`;

// ---------------------------------------------------------------------------------------
// 1. What each page load, click and poll costs with a full history.
// ---------------------------------------------------------------------------------------

test('measure: GM traffic per page load, click and poll with a 5,000-visit history (sync off)', async t => {
    const store = makeStore();
    store.write(STATE_KEY, bigHistory());
    const docBytes = store.data.get(STATE_KEY).length;
    t.diagnostic(`main document: ${kb(docBytes)}`);
    const m = meter(store);
    const polls = [];
    const hookPoll = window => {
        const setInterval = window.setInterval.bind(window);
        window.setInterval = (callback, ms) => {
            if (ms === 45000) polls.push(callback);
            return setInterval(callback, ms);
        };
    };

    let before = m.snapshot();
    const listingTab = await openTab(store, { html: listing(), url: 'https://javstore.net/416-av-uncensored-page-19-cn.html', beforeRun: hookPoll });
    await settle();
    const listingLoad = m.since(before);
    t.diagnostic(`listing page load: ${describe(listingLoad)}`);

    before = m.snapshot();
    await openTab(store, { html: detailHtml, url: 'https://javstore.net/700001-Item-pn.html' });
    await waitFor(() => store.state().visited['https://javstore.net/700001-Item-pn.html']);
    await settle();
    const itemLoad = m.since(before);
    t.diagnostic(`item page load (records the visit): ${describe(itemLoad)}`);

    before = m.snapshot();
    clickCard(listingTab.window, '/a.html');
    await waitFor(() => store.state().visited[abs('/a.html')]);
    await settle();
    const click = m.since(before);
    t.diagnostic(`one click on a tile: ${describe(click)}`);

    before = m.snapshot();
    const started = performance.now();
    await polls[0]();
    const pollMs = performance.now() - started;
    const poll = m.since(before);
    t.diagnostic(`one 45 s poll in a visible tab: ${describe(poll)}, ${pollMs.toFixed(1)} ms in jsdom`);

    before = m.snapshot();
    listingTab.window.document.dispatchEvent(new listingTab.window.Event('visibilitychange'));
    listingTab.window.dispatchEvent(new listingTab.window.Event('focus'));
    await settle();
    const activation = m.since(before);
    t.diagnostic(`tab activation (visibilitychange + focus): ${describe(activation)}`);

    // Every save reads the document, writes it, and reads it back.
    assert.ok(itemLoad.mainWrites >= 1 && itemLoad.writeBytes >= docBytes * 0.9);
    assert.ok(click.mainReads >= 2, 'a save reads the whole document and reads it back');
    assert.equal(activation.mainReads, 2, 'activation re-reads the whole document twice (once per event)');
});

test('measure: GM traffic for an item page load and its push with sync on (session current)', async t => {
    const store = makeStore();
    store.write(STATE_KEY, bigHistory());
    const remote = makeRemote();
    enableSync(store, remote);
    // Establish a session the way a first page does.
    await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle();
    const m = meter(store);
    const requests = remote.requests.length;

    const before = m.snapshot();
    await openTab(store, { html: detailHtml, url: 'https://javstore.net/700002-Item-pn.html', remote });
    await settle();
    const load = m.since(before);
    t.diagnostic(`item page load, sync on: ${describe(load)}; worker requests ${remote.requests.length - requests}`);

    const beforePush = m.snapshot();
    await waitFor(() => remote.requests.length > requests, { timeout: 9000 });
    await settle();
    const push = m.since(beforePush);
    t.diagnostic(`debounced push 4 s later: ${describe(push)}; worker requests ${remote.requests.length - requests}`);
    assert.ok(load.sessionWrites >= 1, 'every page load writes the session key');
    assert.ok(load.mainReads + push.mainReads >= 4, 'the document is read in full several times per page');
});

// ---------------------------------------------------------------------------------------
// 2. boot(): journals folded in without their removals.
//
// boot() calls initializeState(combineSnapshot(...)). combineSnapshot takes the newest
// visit from every journal but only carries resetAt and tombstones along ("mergeStoredState
// does that for whoever reads the result"), and initializeState applies none of them. An
// item page journals its own visit, so for the journal's lifetime every new page boots with
// visits that were unmarked or cleared since, paints them visited, and its first save
// writes them back into the main document next to their tombstone, after which they load
// from the main document for good. Happens on any engine, not only snapshot ones.
// Both tests below failed on cc0f03b; initializeState now applies the removals.
// ---------------------------------------------------------------------------------------

test('a visit unmarked with V stays unmarked in tabs opened afterwards', async () => {
    const store = makeStore();
    await openTab(store, { html: detailHtml, url: abs('/a.html') }); // journals its own visit
    await waitFor(() => visitedUrls(store).length === 1);
    const listingTab = await openTab(store, { html: listing() });
    pressOnCard(listingTab.window, '/a.html', 'v');
    await waitFor(() => visitedUrls(store).length === 0);
    await settle();

    const next = await openTab(store, { html: listing() });
    assert.ok(!card(next.window, '/a.html').classList.contains('jvs-visited'), 'painted unvisited');
    clickCard(next.window, '/b.html');
    await settle();
    assert.deepEqual(visitedUrls(store), [abs('/b.html')], 'the next save does not write it back');
});

test('"Clear visited history" is not undone by journals of other pages', async () => {
    const store = makeStore();
    await openTab(store, { html: detailHtml, url: abs('/a.html') });
    await waitFor(() => visitedUrls(store).length === 1);
    const listingTab = await openTab(store, { html: listing() });
    listingTab.shadow().querySelector('.clear').click();
    await waitFor(() => visitedUrls(store).length === 0);
    await settle();

    const next = await openTab(store, { html: listing() });
    assert.ok(!card(next.window, '/a.html').classList.contains('jvs-visited'), 'painted unvisited');
    clickCard(next.window, '/b.html');
    await settle();
    assert.deepEqual(visitedUrls(store), [abs('/b.html')]);
});

// ---------------------------------------------------------------------------------------
// 3. Long-open tabs on a snapshot engine.
// ---------------------------------------------------------------------------------------

// Tab A has been open for hours. It loaded when tab B's journal was already more than a
// TTL old. B is still open and keeps recording: each save rewrites B's journal. A's first
// save then "retires" B's journal: it checks writtenAt against its own snapshot, which
// still holds B's old journal, so it deletes the live key. A's main-document write has
// already dropped what B recorded after A loaded, so nothing in storage holds it.
test('a long-open tab does not delete journals other live tabs have rewritten since it loaded', { todo: 'retireJournals trusts a stale snapshot (data loss)' }, async () => {
    const store = makeStore({ snapshotPerTab: true });
    const b = await openTab(store, { html: listing() });
    clickCard(b.window, '/a.html');
    await waitFor(() => store.journals().length === 1);
    const [bJournal] = store.journals();
    age(store, bJournal);

    const a = await openTab(store, { html: listing() }); // the long-open tab
    clickCard(b.window, '/b.html'); // B records more; its journal is rewritten now
    await waitFor(() => store.read(bJournal)?.visited?.[abs('/b.html')]);
    await settle();

    clickCard(a.window, '/c.html'); // A's first save, hours later
    await settle(80);

    const fresh = await openTab(store, { html: listing() });
    assert.ok(card(fresh.window, '/b.html').classList.contains('jvs-visited'),
        'B\'s visit survives A\'s save');
    assert.ok(store.journals().includes(bJournal), 'B\'s live journal is still there');
});

// The common case with 40 tabs: tab C is opened after A, records a visit and is closed.
// A fresh tab later merges C's journal into the main document and, a TTL on, retires it.
// Then A, which loaded before C existed, saves: its write is built on the snapshot it took
// at load and drops C's visit. No journal is left to bring it back.
test('a long-open tab\'s save does not drop visits other tabs recorded after it loaded', { todo: 'stale tabs write the whole document (data loss when sync is off or the push failed)' }, async () => {
    const store = makeStore({ snapshotPerTab: true });
    const a = await openTab(store, { html: listing() }); // open for hours
    const c = await openTab(store, { html: detailHtml, url: 'https://javstore.net/700003-Item-pn.html' });
    await waitFor(() => visitedUrls(store).includes('https://javstore.net/700003-Item-pn.html'));
    await settle();
    closeTab(c);
    store.journals().forEach(key => age(store, key));

    const d = await openTab(store, { html: listing() });
    clickCard(d.window, '/b.html'); // a fresh save that retires C's aged journal
    await waitFor(() => store.journals().length === 1);
    await settle();
    assert.ok(visitedUrls(store).includes('https://javstore.net/700003-Item-pn.html'));

    clickCard(a.window, '/a.html');
    await settle(80);
    const e = await openTab(store, { html: listing() });
    await settle();
    assert.ok(visitedUrls(store).includes('https://javstore.net/700003-Item-pn.html'),
        'the visit C recorded is still stored after A saved');
    assert.ok(card(e.window, '/a.html'));
});

// A V-unmark is a per-URL tombstone, and a journal carries it only while it is newer than
// the journal's horizon (resetAt, by contrast, rides in every journal, so a clear
// survives in whichever fresh journal is newest). Once the unmarking tab's journal has
// been retired, a tab that loaded before the unmark writes the visit back without the
// tombstone, and every later page shows it as visited again.
test('a long-open tab cannot undo a V-unmark once the unmarking journal is retired', { todo: 'stale tabs write the whole document (unmarked visits come back)' }, async () => {
    const store = makeStore({ snapshotPerTab: true });
    const seed = await openTab(store, { html: listing() });
    clickCard(seed.window, '/a.html');
    await waitFor(() => visitedUrls(store).length === 1);
    closeTab(seed);

    const a = await openTab(store, { html: listing() }); // open for hours
    const unmarker = await openTab(store, { html: listing() });
    pressOnCard(unmarker.window, '/a.html', 'v');
    await waitFor(() => visitedUrls(store).length === 0);
    await settle();
    closeTab(unmarker);
    store.journals().forEach(key => age(store, key));
    const d = await openTab(store, { html: listing() });
    clickCard(d.window, '/c.html'); // a fresh save that retires the aged journals
    await waitFor(() => visitedUrls(store).includes(abs('/c.html')) && store.journals().length === 1);
    await settle();

    clickCard(a.window, '/b.html'); // any save by the long-open tab
    await settle(80);
    const e = await openTab(store, { html: listing() });
    assert.ok(!card(e.window, '/a.html').classList.contains('jvs-visited'), 'the unmarked visit stays unmarked');
});

// The sync lock is held for the whole exchange. GM_xmlhttpRequest has a 20 s timeout, but
// the fetch fallback (used whenever the manager refuses the GM request, as AdGuard can)
// has none: one tab whose request never settles holds the Web Lock until it is closed, and
// every other tab's sync queues behind it. Timers in the hung tab are sped up 100x, so a
// page-side timeout of REMOTE_TIMEOUT_MS would release the lock within a fraction of a
// second here.
test('a request that never settles in one tab does not block every other tab\'s sync', { todo: 'fetchRemote has no timeout; the lock is held indefinitely (sync stalls on all tabs)' }, async () => {
    const store = makeStore();
    const remote = makeRemote();
    enableSync(store, remote);
    await openTab(store, { html: listing(), remote, beforeRun(window) {
        window.GM_xmlhttpRequest = ({ onerror }) => onerror({ error: 'Forbidden' });
        window.fetch = () => new Promise(() => {});
        const setTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, ms, ...rest) => setTimeout(callback, ms >= 1000 ? ms / 100 : ms, ...rest);
    } });
    await settle();
    await openTab(store, { html: listing(), remote });
    await waitFor(() => remote.requests.length > 0, { timeout: 3000 }).catch(() => {});
    assert.ok(remote.requests.length > 0, 'the second tab reached the worker');
});

// With sync on, a tab that has been open past REMOTE_REFRESH_MIN_GAP_MS syncs every time
// it is activated. On a snapshot engine it reads the session and cursor it loaded with,
// so the shared-session shortcut never applies to it: each activation is a worker request,
// and when its old cursor brings rows down, a full read-merge-write of the document.
test('measure: activating long-open tabs on a snapshot engine with sync on', async t => {
    const remote = makeRemote();
    const store = makeStore({ snapshotPerTab: true });
    enableSync(store, remote);
    const first = await openTab(store, { html: listing(), remote });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle();
    let skew = 0;
    const tabs = [];
    for (let i = 0; i < 10; i++) {
        tabs.push(await openTab(store, { html: listing(), remote, beforeRun(window) {
            const now = window.Date.now.bind(window.Date);
            window.Date.now = () => now() + skew;
        } }));
    }
    await settle();
    // Other tabs and devices keep adding visits; the worker has them.
    remote.store.sync({ cursor: 0, changes: Array.from({ length: 20 }, (_, i) => ({ kind: 'v', key: `https://javstore.net/other-${i}.html`, at: Date.now() - 1000 + i })) });
    clickCard(first.window, '/a.html');
    await waitFor(() => remote.requests.length >= 2, { timeout: 9000 });
    await settle();

    const requests = remote.requests.length;
    let writes = 0;
    const set = store.set.bind(store);
    store.set = async (key, value) => { if (key === STATE_KEY) writes++; return set(key, value); };
    skew = 2 * 60000; // two minutes later the user flips through the tabs
    for (const tab of tabs) {
        tab.window.document.dispatchEvent(new tab.window.Event('visibilitychange'));
        tab.window.dispatchEvent(new tab.window.Event('focus'));
    }
    await waitFor(() => remote.requests.length >= requests + tabs.length, { timeout: 9000 }).catch(() => {});
    await settle(80);
    t.diagnostic(`10 long-open tabs activated once each: ${remote.requests.length - requests} worker requests, ${writes} full-document writes`);
    assert.ok(remote.requests.length - requests >= tabs.length, 'each stale tab syncs on activation');
});

// ---------------------------------------------------------------------------------------
// 4. Page lifecycle.
// ---------------------------------------------------------------------------------------

// visibilitychange and focus both fire when a tab is activated, and both start a sync:
// lastRemoteAttemptAt is set only once runSync gets the lock, after both handlers ran.
// The second one finds the session fresh and only reads storage and rewrites the session,
// but that is still two full-document reads on top of the two refreshFromStorage reads.
test('measure: one tab activation runs two syncs (visibilitychange and focus)', async t => {
    const store = makeStore();
    const remote = makeRemote();
    enableSync(store, remote);
    let skew = 0;
    const tab = await openTab(store, { html: listing(), remote, beforeRun(window) {
        const now = window.Date.now.bind(window.Date);
        window.Date.now = () => now() + skew;
    } });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    await settle();
    const m = meter(store);
    skew = 2 * 60000;
    const before = m.snapshot();
    tab.window.document.dispatchEvent(new tab.window.Event('visibilitychange'));
    tab.window.dispatchEvent(new tab.window.Event('focus'));
    await settle(80);
    const cost = m.since(before);
    t.diagnostic(`activation with sync on: ${describe(cost)}, session writes ${cost.sessionWrites}, requests ${remote.requests.length - 1}`);
    assert.equal(cost.sessionWrites, 2, 'both handlers queue a sync before either records its attempt');
    assert.ok(cost.mainReads >= 4, 'two refreshes plus two sync snapshots read the document');
});

// After the page comes back from the back/forward cache its timers are restarted and the
// tab syncs; a click recorded before it was hidden is still pushed.
test('a page restored from the back/forward cache syncs again and keeps its poll timers', async () => {
    const store = makeStore();
    const remote = makeRemote();
    enableSync(store, remote);
    const intervals = new Set();
    const tab = await openTab(store, { html: listing(), remote, beforeRun(window) {
        const setInterval = window.setInterval.bind(window);
        const clearInterval = window.clearInterval.bind(window);
        window.setInterval = (callback, ms) => { const id = setInterval(callback, ms); intervals.add(id); return id; };
        window.clearInterval = id => { intervals.delete(id); clearInterval(id); };
    } });
    await waitFor(() => store.read(SESSION_KEY)?.completedAt);
    assert.equal(intervals.size, 2, 'storage poll and remote poll');
    tab.window.dispatchEvent(new tab.window.Event('pagehide'));
    assert.equal(intervals.size, 0, 'both timers stop on pagehide');
    const restored = new tab.window.Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    tab.window.dispatchEvent(restored);
    assert.equal(intervals.size, 2, 'both timers come back');
    clickCard(tab.window, '/a.html');
    await waitFor(() => remote.visited().includes(abs('/a.html')), { timeout: 9000 });
});

// ---------------------------------------------------------------------------------------
// 5. Early paint and the observer.
// ---------------------------------------------------------------------------------------

test('measure: tiles are processed a bounded number of times while a 600-tile listing streams in', async t => {
    const store = makeStore();
    store.write(STATE_KEY, bigHistory());
    const hrefs = Array.from({ length: 600 }, (_, i) => `https://javstore.net/${600000 + i}-FC2-PPV-${3000000 + i}-Some-Typical-Title-Words-pn.html`);
    let processed = 0;
    const tab = await openTab(store, { html: '<!doctype html><html><head></head><body><main><div class="grid"></div></main></body></html>', beforeRun(window) {
        Object.defineProperty(window.document, 'readyState', { configurable: true, get: () => 'loading' });
        const setAttribute = window.Element.prototype.setAttribute;
        window.Element.prototype.setAttribute = function (name, value) {
            if (name === 'aria-description') processed++;
            return setAttribute.call(this, name, value);
        };
    } });
    const grid = tab.window.document.querySelector('main .grid');
    const started = performance.now();
    // The parser appends one element at a time; tasks in between let the observer run.
    for (let i = 0; i < hrefs.length; i += 20) {
        for (const href of hrefs.slice(i, i + 20)) {
            const a = tab.window.document.createElement('a');
            a.href = href;
            a.innerHTML = '<div class="aspect-video"><img src="x.jpg"></div><h3>Title</h3>';
            grid.append(a);
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    await settle();
    const ms = performance.now() - started;
    const visited = tab.window.document.querySelectorAll('a.jvs-visited').length;
    t.diagnostic(`600 tiles: ${processed} processCard passes (${(processed / 600).toFixed(2)} per tile), ${visited} marked visited, ${ms.toFixed(0)} ms in jsdom`);
    assert.equal(visited, 600);
    assert.ok(processed / 600 <= 3);
});
