import { JSDOM, VirtualConsole } from 'jsdom';
import worker from '../worker/src/worker.mjs';
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
        get(key, fallback) {
            return Promise.resolve(data.has(key) ? JSON.parse(data.get(key)) : fallback);
        },
        set(key, value) {
            if (this.dropWrites) return Promise.resolve();
            data.set(key, JSON.stringify(value));
            return Promise.resolve();
        },
        state() {
            const raw = data.get('javstore_cleanup_state_v2');
            return raw ? JSON.parse(raw) : null;
        },
    };
}

// The sync backend under test is the real worker, driven through a Map that stands in for
// the KV namespace, so the tests exercise both halves of a sync rather than a mock of one.
function makeKv() {
    const data = new Map();
    const kv = {
        data,
        writes: 0,
        async get(key, type) {
            const raw = data.get(key);
            if (raw === undefined) return null;
            return type === 'json' ? JSON.parse(raw) : raw;
        },
        async put(key, value) {
            kv.writes += 1;
            data.set(key, String(value));
        },
    };
    return kv;
}

export function makeRemote({ token = 'test-token', origin = 'https://sync.test' } = {}) {
    const kv = makeKv();
    const remote = {
        kv,
        token,
        endpoint: `${origin}/state`,
        offline: false,
        requests: [],
        env: { SYNC_TOKEN: token, JAVSTORE_SYNC: kv, ALLOWED_ORIGIN: '*' },
        async handle({ method, url, headers, body }) {
            if (remote.offline) throw new Error('network unreachable');
            remote.requests.push({ method, url, headers, body });
            const response = await worker.fetch(new Request(url, { method, headers, body }), remote.env);
            return { status: response.status, statusText: '', text: await response.text() };
        },
        state() {
            const raw = kv.data.get('state');
            return raw ? JSON.parse(raw) : null;
        },
        visited() {
            return Object.keys(remote.state()?.visited || {}).sort();
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
        window.GM_xmlhttpRequest = ({ method, url, headers, data, onload, onerror }) => {
            remote.handle({ method, url, headers, body: data })
                .then(response => onload({
                    status: response.status,
                    statusText: response.statusText,
                    responseText: response.text,
                }))
                .catch(error => onerror({ error: String(error) }));
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
