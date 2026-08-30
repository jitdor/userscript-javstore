// Cloud sync backend for the JavStore Full Layout Cleanup userscript.
//
// One document per deployment, held in a Cloudflare KV namespace. A device POSTs the whole
// document it holds; the worker merges it into the stored one and answers with the result,
// so a device that has been offline for a week can never overwrite what the others recorded
// in the meantime. The merge rules are the userscript's own: newest timestamp wins per URL,
// a tombstone outranks an entry of the same age or older, and `resetAt`/`prunedBefore` are
// horizons below which nothing survives.
//
// KV is eventually consistent, so two devices syncing in the same second can read the same
// version and one write can land on top of the other. That is recoverable rather than
// destructive here: every device pushes its complete document on every sync, so whatever a
// lost write dropped comes back on the next one.

const STORAGE_VERSION = 3;
const DOCUMENT_KEY = 'state';
const MAX_VISITED_ITEMS = 5000;
const MAX_TOMBSTONES = 2000;
const TOMBSTONE_TTL_MS = 90 * 86400000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function emptyDocument() {
    return {
        version: STORAGE_VERSION,
        updatedAt: 0,
        settingsUpdatedAt: 0,
        resetAt: 0,
        prunedBefore: 0,
        settings: null,
        visited: {},
        overrides: {},
        overrideTimes: {},
        tombstones: {},
    };
}

function timestamp(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? time : 0;
}

function timestampMap(value) {
    const result = new Map();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [key, raw] of Object.entries(value)) {
        const time = timestamp(raw);
        if (key && time) result.set(String(key).slice(0, 2000), time);
    }
    return result;
}

function overrideMap(value) {
    const result = new Map();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [key, raw] of Object.entries(value)) {
        if (raw === 'allow' || raw === 'block') result.set(String(key).slice(0, 2000), raw);
    }
    return result;
}

function sortedObject(entries) {
    return Object.fromEntries([...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// Applied identically in the userscript, so both sides of a sync keep the same entries
// instead of handing each other back the ones the other just dropped.
function capOldestFirst(map, limit) {
    if (map.size <= limit) return;
    [...map.entries()]
        .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))
        .slice(0, map.size - limit)
        .forEach(([key]) => map.delete(key));
}

function settingsAge(document) {
    return Object.prototype.hasOwnProperty.call(document, 'settingsUpdatedAt')
        ? timestamp(document.settingsUpdatedAt)
        : timestamp(document.updatedAt);
}

export function mergeDocuments(base, incoming, now = Date.now()) {
    const left = base && typeof base === 'object' ? base : emptyDocument();
    const right = incoming && typeof incoming === 'object' ? incoming : emptyDocument();

    const resetAt = Math.max(timestamp(left.resetAt), timestamp(right.resetAt));
    const prunedBefore = Math.max(timestamp(left.prunedBefore), timestamp(right.prunedBefore));

    const tombstones = timestampMap(left.tombstones);
    for (const [key, at] of timestampMap(right.tombstones)) {
        if (at > (tombstones.get(key) || 0)) tombstones.set(key, at);
    }
    for (const [key, at] of tombstones) {
        if (now - at > TOMBSTONE_TTL_MS) tombstones.delete(key);
    }
    capOldestFirst(tombstones, MAX_TOMBSTONES);

    const visited = timestampMap(left.visited);
    for (const [url, at] of timestampMap(right.visited)) {
        if (at > (visited.get(url) || 0)) visited.set(url, at);
    }
    for (const [url, at] of visited) {
        const buried = tombstones.get(`v|${url}`) || 0;
        if (at <= resetAt || at <= prunedBefore || at <= buried) visited.delete(url);
    }
    capOldestFirst(visited, MAX_VISITED_ITEMS);

    const overrides = overrideMap(left.overrides);
    const overrideTimes = timestampMap(left.overrideTimes);
    const rightOverrides = overrideMap(right.overrides);
    const rightOverrideTimes = timestampMap(right.overrideTimes);
    for (const [url, value] of rightOverrides) {
        const at = rightOverrideTimes.get(url) || 0;
        if (overrides.has(url) && at < (overrideTimes.get(url) || 0)) continue;
        overrides.set(url, value);
        overrideTimes.set(url, at);
    }
    for (const [url, at] of overrideTimes) {
        if (at < (tombstones.get(`o|${url}`) || 0)) {
            overrides.delete(url);
            overrideTimes.delete(url);
        }
    }
    for (const url of [...overrideTimes.keys()]) {
        if (!overrides.has(url)) overrideTimes.delete(url);
    }

    // Settings travel with their own timestamp: a device that never touched them carries a
    // zero and so can never push its defaults over another device's choices. Only a document
    // predating the field falls back to its `updatedAt`.
    const leftSettingsAt = settingsAge(left);
    const rightSettingsAt = settingsAge(right);
    const rightWins = right.settings && typeof right.settings === 'object'
        && (rightSettingsAt > leftSettingsAt || !left.settings || typeof left.settings !== 'object');

    return {
        version: STORAGE_VERSION,
        updatedAt: Math.max(timestamp(left.updatedAt), timestamp(right.updatedAt), now),
        settingsUpdatedAt: rightWins ? rightSettingsAt : leftSettingsAt,
        resetAt,
        prunedBefore,
        settings: rightWins ? right.settings : (left.settings ?? null),
        visited: sortedObject(visited),
        overrides: sortedObject(overrides),
        overrideTimes: sortedObject(overrideTimes),
        tombstones: sortedObject(tombstones),
    };
}

// `updatedAt` moves on every merge by design, so it is not part of what makes two versions
// of the document the same.
function sameDocument(left, right) {
    return JSON.stringify({ ...left, updatedAt: 0 }) === JSON.stringify({ ...right, updatedAt: 0 });
}

function corsHeaders(env) {
    return {
        'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || 'https://javstore.net',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

function json(body, status, env) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...corsHeaders(env),
        },
    });
}

// Compares in constant time for equal-length strings; only the token's length can leak.
function tokenMatches(presented, expected) {
    if (typeof presented !== 'string' || typeof expected !== 'string') return false;
    if (presented.length !== expected.length || !expected) return false;
    let mismatch = 0;
    for (let index = 0; index < presented.length; index += 1) {
        mismatch |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    return mismatch === 0;
}

function presentedToken(request) {
    const header = request.headers.get('Authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : '';
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(env) });
        }
        if (!env?.SYNC_TOKEN) {
            return json({ error: 'The worker has no SYNC_TOKEN secret configured.' }, 500, env);
        }
        if (!tokenMatches(presentedToken(request), env.SYNC_TOKEN)) {
            return json({ error: 'Unauthorized.' }, 401, env);
        }
        if (!env?.JAVSTORE_SYNC) {
            return json({ error: 'The worker has no JAVSTORE_SYNC KV binding.' }, 500, env);
        }

        const stored = (await env.JAVSTORE_SYNC.get(DOCUMENT_KEY, 'json')) || emptyDocument();

        if (request.method === 'GET') {
            return json({ state: stored }, 200, env);
        }
        if (request.method !== 'POST') {
            return json({ error: 'Use GET to read or POST to sync.' }, 405, env);
        }

        let body;
        try {
            const text = await request.text();
            if (text.length > MAX_BODY_BYTES) {
                return json({ error: 'The document is too large to sync.' }, 413, env);
            }
            body = JSON.parse(text);
        } catch (error) {
            return json({ error: 'The request body is not JSON.' }, 400, env);
        }

        const incoming = body && typeof body === 'object'
            ? (body.state && typeof body.state === 'object' ? body.state : body)
            : null;
        if (!incoming) {
            return json({ error: 'The request carried no state.' }, 400, env);
        }

        const merged = mergeDocuments(stored, incoming);
        // Most syncs are a device confirming it already agrees with the worker—a page load
        // with nothing new to report. Writing those back would burn the KV write allowance
        // and churn `updatedAt` for every other device, so only a real change is stored.
        if (sameDocument(stored, merged)) {
            return json({ state: stored }, 200, env);
        }
        await env.JAVSTORE_SYNC.put(DOCUMENT_KEY, JSON.stringify(merged));
        return json({ state: merged }, 200, env);
    },
};
