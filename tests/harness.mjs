import { JSDOM, VirtualConsole } from 'jsdom';
import worker, { SyncStore } from '../worker/src/worker.mjs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = process.env.SCRIPT_PATH
    || path.join(here, '..', 'javstore-full-layout-cleanup.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');

const openWindows = new Set();

// Stands in for AdGuard's userscript engine: one shared value store, asynchronous
// GM_getValue/GM_setValue, and neither GM_addValueChangeListener nor GM_registerMenuCommand.
export function makeStore() {
    const data = new Map();
    return {
        data,
        dropWrites: false,
        // Storage that rejects the history document while still taking the small
        // bookkeeping values: that is the shape of a quota refusal, and the case where a
        // sync must not record a cursor for rows it could not save.
        dropStateWrites: false,
        get(key, fallback) {
            return Promise.resolve(data.has(key) ? JSON.parse(data.get(key)) : fallback);
        },
        set(key, value) {
            if (this.dropWrites) return Promise.resolve();
            if (this.dropStateWrites && key === 'javstore_cleanup_state_v2') return Promise.resolve();
            data.set(key, JSON.stringify(value));
            return Promise.resolve();
        },
        state() {
            const raw = data.get('javstore_cleanup_state_v2');
            return raw ? JSON.parse(raw) : null;
        },
    };
}

// The sync backend under test is the real worker: its Durable Object class runs against a
// node:sqlite database standing in for `ctx.storage.sql`, which has the same synchronous
// exec-and-iterate shape. That keeps the tests fast while exercising the actual SQL.
function makeSqlStorage() {
    const db = new DatabaseSync(':memory:');
    return {
        db,
        exec(query, ...bindings) {
            const rows = db.prepare(query).all(...bindings);
            return {
                toArray: () => rows,
                one: () => rows[0],
                [Symbol.iterator]: () => rows[Symbol.iterator](),
            };
        },
    };
}

export function makeRemote({
    token = 'test-token',
    origin = 'https://sync.test',
    legacyDocument = null,
} = {}) {
    const storage = makeSqlStorage();
    const env = { SYNC_TOKEN: token, ALLOWED_ORIGIN: '*' };
    if (legacyDocument) {
        env.JAVSTORE_SYNC = { get: async () => legacyDocument };
    }
    const store = new SyncStore({ storage: { sql: storage.sql ?? storage } }, env);
    env.SYNC_STORE = {
        idFromName: name => ({ name }),
        get: () => ({ fetch: request => store.fetch(request) }),
    };

    const remote = {
        store,
        env,
        token,
        endpoint: `${origin}/state`,
        offline: false,
        requests: [],
        async handle({ method, url, headers, body }) {
            if (remote.offline) throw new Error('network unreachable');
            remote.requests.push({ method, url, headers, body: body ? JSON.parse(body) : null });
            const response = await worker.fetch(new Request(url, { method, headers, body }), env);
            return { status: response.status, statusText: '', text: await response.text() };
        },
        state() {
            return store.document();
        },
        visited() {
            return Object.keys(store.document().visited).sort();
        },
        rows() {
            return storage.db.prepare('SELECT kind, key, at, deleted, seq FROM entries ORDER BY seq').all();
        },
        // What the last sync actually cost on the wire, for the delta-size assertions.
        lastPushedChanges() {
            const last = remote.requests.at(-1)?.body;
            return Array.isArray(last?.changes) ? last.changes : [];
        },
    };
    return remote;
}

export function enableSync(store, remote, overrides = {}) {
    store.data.set('javstore_sync_config_v1', JSON.stringify({
        enabled: true,
        endpoint: remote.endpoint,
        token: remote.token,
        intervalMinutes: 5,
        ...overrides,
    }));
}

const cardHtml = (href, title) =>
    `<a href="${href}"><div class="aspect-video"><img src="${href}.jpg"></div><h3>${title}</h3></a>`;

export function listingHtml(cards) {
    return `<!doctype html><html><head></head><body><main><div class="grid">
        ${cards.map(([href, title]) => cardHtml(href, title)).join('\n')}
    </div></main></body></html>`;
}

export const detailHtml =
    '<!doctype html><html><head></head><body><main><article><h1>Item</h1></article></main></body></html>';

export async function openTab(store, {
    html = listingHtml([]),
    url = 'https://javstore.net/',
    referrer = '',
    session = new Map(),
    remote = null,
} = {}) {
    const options = {
        url,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    };
    if (referrer) options.referrer = referrer;

    const dom = new JSDOM(html, options);
    const { window } = dom;
    openWindows.add(window);

    // sessionStorage belongs to the tab and survives navigation inside it, so the caller
    // hands the same map to the pages that follow one another in a simulated tab.
    Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: {
            getItem: key => (session.has(key) ? session.get(key) : null),
            setItem: (key, value) => session.set(key, String(value)),
            removeItem: key => session.delete(key),
        },
    });
    window.GM_getValue = (key, fallback) => store.get(key, fallback);
    window.GM_setValue = (key, value) => store.set(key, value);
    window.GM_addStyle = () => {};
    window.confirm = () => true;
    if (remote) {
        // A tab may be able to reach more than one worker (the panel can be repointed at a
        // different endpoint), so requests are routed by the URL they were sent to.
        const remotes = Array.isArray(remote) ? remote : [remote];
        const route = url => remotes.find(candidate => url.startsWith(candidate.endpoint)) || remotes[0];
        window.GM_xmlhttpRequest = ({ method, url, headers, data, onload, onerror }) => {
            const target = route(url);
            // `blockGm` stands in for a userscript manager that declines the cross-origin
            // call, which is how AdGuard can behave: no status, the request never leaves.
            if (target.blockGm) {
                onerror({ error: 'Forbidden' });
                return;
            }
            target.handle({ method, url, headers, body: data })
                .then(response => onload({
                    status: response.status,
                    statusText: response.statusText,
                    responseText: response.text,
                }))
                .catch(error => onerror({ error: String(error) }));
        };
        // jsdom has no fetch of its own, so the fallback path gets one that reaches the
        // same workers.
        window.fetch = async (url, { method = 'GET', headers, body } = {}) => {
            const response = await route(url).handle({ method, url, headers, body });
            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                json: async () => JSON.parse(response.text),
            };
        };
    }

    vm.runInContext(source, dom.getInternalVMContext());
    await settle();
    return { dom, window, session, store, shadow: () => window.document.getElementById('jvs-controls-host').shadowRoot };
}

export function closeTabs() {
    openWindows.forEach(window => window.close());
    openWindows.clear();
}

export async function settle(rounds = 40) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

export function card(window, href) {
    const found = window.document.querySelector(`main .grid a[href="${href}"]`);
    if (!found) throw new Error(`card not found: ${href}`);
    return found;
}

export function clickCard(window, href) {
    const target = card(window, href);
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    return target;
}

export function pressOnCard(window, href, key) {
    const target = card(window, href);
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
    return target;
}

export async function waitFor(check, { timeout = 9000, interval = 20 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

export function visitedUrls(store) {
    return Object.keys(store.state()?.visited || {}).sort();
}
