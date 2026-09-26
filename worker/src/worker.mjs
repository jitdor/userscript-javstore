// Cloud sync backend for the JavStore Full Layout Cleanup userscript.
//
// One Durable Object holds the history in its SQLite storage. A Durable Object is
// single-threaded, so the read-merge-write that a sync performs is serialized and strongly
// consistent: two devices syncing in the same second queue behind one another instead of
// both merging into the same stale base. That is the guarantee the earlier KV-backed
// version could not give, and it is the one that matters when the copy a lost write drops
// exists only on a device you are about to lose.
//
// Devices exchange deltas rather than the whole document. Each row carries a server-assigned
// sequence number, so a device asks for "everything after seq N" and pushes only what it has
// touched since its last successful push. An ordinary page load costs a few hundred bytes.
//
// Every entry is last-writer-wins on its own event timestamp, with a deletion winning a tie
// — the same rule the userscript applies locally, so both sides converge on the same state.

const STORAGE_VERSION = 3;
// Reported in every answer so the userscript can show which worker it is talking to. It
// moves in step with the userscript's own version; a test holds the two together.
export const WORKER_VERSION = '6.9.0';
const OBJECT_NAME = 'default';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_ROWS = 2000;
// The server is the archive, so it holds far more than the 5,000 entries a device keeps.
const MAX_ARCHIVED_VISITS = 50000;
const TOMBSTONE_TTL_MS = 90 * 86400000;
const MAX_KEY_LENGTH = 2000;

function timestamp(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? Math.floor(time) : 0;
}

// When each setting was last changed, keyed by setting name. A device or a stored copy
// from before the per-field stamps says only when its settings as a whole last changed, and
// that time stands in for every field it carries.
function settingTimes(settings, times, wholeAt) {
    const result = {};
    if (!settings || typeof settings !== 'object') return result;
    const stamped = times && typeof times === 'object' && !Array.isArray(times);
    for (const field of Object.keys(settings)) {
        const at = stamped ? timestamp(times[field]) : timestamp(wholeAt);
        if (at) result[field] = at;
    }
    return result;
}

// Each field goes to whichever side changed it last, with a tie between different values
// settled on the values themselves—the rule the userscript applies, so both sides agree.
function mergeSettings(current, currentTimes, incoming, incomingTimes) {
    const settings = { ...(current || {}) };
    const times = { ...currentTimes };
    let changed = false;
    for (const [field, at] of Object.entries(incomingTimes)) {
        if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
        const known = timestamp(times[field]);
        if (at < known) continue;
        const next = JSON.stringify(incoming[field]);
        const held = JSON.stringify(settings[field]);
        if (at === known && !(next > held)) continue;
        settings[field] = incoming[field];
        times[field] = at;
        changed = true;
    }
    return { settings, times, changed };
}

function overrideValue(value) {
    return value === 'allow' || value === 'block' ? value : null;
}

export class SyncStore {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.sql = ctx.storage.sql;
        this.imported = false;
        this.#migrate();
    }

    #migrate() {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
            kind    TEXT    NOT NULL,
            key     TEXT    NOT NULL,
            at      INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            value   TEXT,
            seq     INTEGER NOT NULL,
            PRIMARY KEY (kind, key)
        )`);
        this.sql.exec('CREATE INDEX IF NOT EXISTS entries_by_seq ON entries (seq)');
        this.sql.exec('CREATE INDEX IF NOT EXISTS entries_by_at ON entries (kind, deleted, at)');
        this.sql.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    }

    #meta(name, fallback = null) {
        const rows = this.sql.exec('SELECT value FROM meta WHERE name = ?', name).toArray();
        if (!rows.length) return fallback;
        try {
            return JSON.parse(rows[0].value);
        } catch (error) {
            return fallback;
        }
    }

    #setMeta(name, value) {
        this.sql.exec(
            'INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
            name,
            JSON.stringify(value),
        );
    }

    #nextSeq() {
        const next = timestamp(this.#meta('seq', 0)) + 1;
        this.#setMeta('seq', next);
        return next;
    }

    #horizons() {
        return {
            resetAt: timestamp(this.#meta('resetAt', 0)),
            prunedBefore: timestamp(this.#meta('prunedBefore', 0)),
        };
    }

    #readMeta() {
        return {
            resetAt: timestamp(this.#meta('resetAt', 0)),
            prunedBefore: timestamp(this.#meta('prunedBefore', 0)),
            settings: this.#meta('settings', null),
            settingsUpdatedAt: timestamp(this.#meta('settingsUpdatedAt', 0)),
            settingTimes: this.#meta('settingTimes', null),
        };
    }

    // The horizons only ever move forward, and dropping what falls below them is what stops
    // a device that has been offline from resurrecting a cleared history.
    #applyMeta(meta) {
        if (!meta || typeof meta !== 'object') return;
        const current = this.#readMeta();

        const resetAt = timestamp(meta.resetAt);
        if (resetAt > current.resetAt) {
            this.#setMeta('resetAt', resetAt);
            this.sql.exec('DELETE FROM entries WHERE kind = ? AND deleted = 0 AND at <= ?', 'v', resetAt);
        }

        const prunedBefore = timestamp(meta.prunedBefore);
        if (prunedBefore > current.prunedBefore) {
            this.#setMeta('prunedBefore', prunedBefore);
            this.sql.exec('DELETE FROM entries WHERE kind = ? AND deleted = 0 AND at <= ?', 'v', prunedBefore);
        }

        // Each setting carries its own timestamp, so a device that has never changed one
        // sends a zero for it and can never push its default over another device's choice,
        // and a device that changed only its tint does not bring its keywords along.
        if (!meta.settings || typeof meta.settings !== 'object' || Array.isArray(meta.settings)) return;
        const incomingTimes = settingTimes(meta.settings, meta.settingTimes, meta.settingsUpdatedAt);
        if (!current.settings) {
            this.#setMeta('settings', meta.settings);
            this.#setMeta('settingTimes', incomingTimes);
            this.#setMeta('settingsUpdatedAt', timestamp(meta.settingsUpdatedAt));
            return;
        }
        const currentTimes = settingTimes(current.settings, current.settingTimes, current.settingsUpdatedAt);
        const merged = mergeSettings(current.settings, currentTimes, meta.settings, incomingTimes);
        if (!merged.changed) return;
        this.#setMeta('settings', merged.settings);
        this.#setMeta('settingTimes', merged.times);
        this.#setMeta('settingsUpdatedAt', Math.max(
            current.settingsUpdatedAt,
            ...Object.values(merged.times),
        ));
    }

    #existing(kind, key) {
        const rows = this.sql
            .exec('SELECT kind, key, at, deleted, value, seq FROM entries WHERE kind = ? AND key = ?', kind, key)
            .toArray();
        return rows.length ? rows[0] : null;
    }

    // Returns the row the device should be told about instead: null when it is already in
    // step, or the winning row when what it sent has been beaten by something newer.
    #applyChange(change) {
        if (!change || typeof change !== 'object') return null;
        const kind = change.kind === 'o' ? 'o' : 'v';
        const key = String(change.key || '').slice(0, MAX_KEY_LENGTH);
        const at = timestamp(change.at);
        const deleted = change.deleted ? 1 : 0;
        const value = kind === 'o' && !deleted ? overrideValue(change.value) : null;
        if (!key || !at) return null;
        if (kind === 'o' && !deleted && !value) return null;

        const { resetAt, prunedBefore } = this.#horizons();
        if (kind === 'v' && !deleted && (at <= resetAt || at <= prunedBefore)) return null;

        const existing = this.#existing(kind, key);
        if (existing) {
            const wins = at > existing.at || (at === existing.at && deleted && !existing.deleted);
            if (!wins) {
                const agreed = existing.at === at
                    && Boolean(existing.deleted) === Boolean(deleted)
                    && (existing.value || null) === value;
                return agreed ? null : existing;
            }
        }

        this.sql.exec(
            `INSERT INTO entries (kind, key, at, deleted, value, seq) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(kind, key) DO UPDATE SET
                at = excluded.at, deleted = excluded.deleted, value = excluded.value, seq = excluded.seq`,
            kind, key, at, deleted, value, this.#nextSeq(),
        );
        return null;
    }

    #prune(now) {
        // Tombstones only need to outlive the stale snapshots they protect against.
        this.sql.exec('DELETE FROM entries WHERE deleted = 1 AND at < ?', now - TOMBSTONE_TTL_MS);

        const counted = this.sql
            .exec('SELECT COUNT(*) AS total FROM entries WHERE kind = ? AND deleted = 0', 'v')
            .toArray();
        const total = Number(counted[0]?.total || 0);
        if (total <= MAX_ARCHIVED_VISITS) return;
        // Dropped outright rather than tombstoned: a device that still holds one of these
        // will not push it back, because it is older than that device's last push.
        this.sql.exec(
            `DELETE FROM entries WHERE rowid IN (
                SELECT rowid FROM entries WHERE kind = ? AND deleted = 0
                ORDER BY at ASC, key ASC LIMIT ?
            )`,
            'v',
            total - MAX_ARCHIVED_VISITS,
        );
    }

    // One sync: hand the device everything recorded since the sequence number it last saw,
    // take what it has touched since its last push, and report the new sequence number.
    sync(payload, now = Date.now()) {
        const cursor = timestamp(payload.cursor);
        const limit = Math.min(MAX_PAGE_ROWS, Math.max(1, Number(payload.limit) || MAX_PAGE_ROWS));

        // Read before writing: the rows this request is about to store are ones the device
        // already has, so echoing them straight back would waste the round trip.
        const ahead = this.sql
            .exec(
                'SELECT kind, key, at, deleted, value, seq FROM entries WHERE seq > ? ORDER BY seq LIMIT ?',
                cursor,
                limit + 1,
            )
            .toArray();
        const more = ahead.length > limit;
        const changes = more ? ahead.slice(0, limit) : ahead;

        this.#applyMeta(payload.meta);

        const incoming = Array.isArray(payload.changes) ? payload.changes : [];
        const seen = new Set(changes.map(row => `${row.kind}|${row.key}`));
        for (const change of incoming) {
            const correction = this.#applyChange(change);
            if (!correction) continue;
            const id = `${correction.kind}|${correction.key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            changes.push(correction);
        }

        if (incoming.length) this.#prune(now);

        return {
            worker: WORKER_VERSION,
            cursor: more ? changes[limit - 1].seq : timestamp(this.#meta('seq', 0)),
            more,
            meta: this.#readMeta(),
            changes: changes.map(row => ({
                kind: row.kind,
                key: row.key,
                at: row.at,
                deleted: row.deleted ? 1 : 0,
                ...(row.value ? { value: row.value } : {}),
            })),
        };
    }

    // The 6.2.0 shape, kept so a device that has not been updated still syncs, and so a
    // plain GET can hand you the whole history for a backup.
    document() {
        const meta = this.#readMeta();
        const visited = {};
        const overrides = {};
        const overrideTimes = {};
        const tombstones = {};
        for (const row of this.sql.exec('SELECT kind, key, at, deleted, value FROM entries ORDER BY key')) {
            if (row.deleted) {
                tombstones[`${row.kind}|${row.key}`] = row.at;
            } else if (row.kind === 'v') {
                visited[row.key] = row.at;
            } else if (row.value) {
                overrides[row.key] = row.value;
                overrideTimes[row.key] = row.at;
            }
        }
        return {
            version: STORAGE_VERSION,
            updatedAt: Date.now(),
            settingsUpdatedAt: meta.settingsUpdatedAt,
            ...(meta.settingTimes ? { settingTimes: meta.settingTimes } : {}),
            resetAt: meta.resetAt,
            prunedBefore: meta.prunedBefore,
            settings: meta.settings,
            visited,
            overrides,
            overrideTimes,
            tombstones,
        };
    }

    applyDocument(state, now = Date.now()) {
        this.#applyMeta({
            resetAt: state.resetAt,
            prunedBefore: state.prunedBefore,
            settings: state.settings,
            settingTimes: state.settingTimes,
            settingsUpdatedAt: Object.prototype.hasOwnProperty.call(state, 'settingsUpdatedAt')
                ? state.settingsUpdatedAt
                : state.updatedAt,
        });

        const changes = [];
        const entries = value => (value && typeof value === 'object' && !Array.isArray(value)
            ? Object.entries(value)
            : []);
        for (const [key, at] of entries(state.tombstones)) {
            const kind = key.startsWith('o|') ? 'o' : 'v';
            changes.push({ kind, key: key.slice(2), at, deleted: 1 });
        }
        for (const [key, at] of entries(state.visited)) {
            changes.push({ kind: 'v', key, at });
        }
        const overrideTimes = new Map(entries(state.overrideTimes));
        for (const [key, value] of entries(state.overrides)) {
            changes.push({ kind: 'o', key, at: overrideTimes.get(key) || 0, value });
        }
        changes.forEach(change => this.#applyChange(change));
        if (changes.length) this.#prune(now);
    }

    // A namespace left over from the KV-backed version is imported once, so upgrading the
    // worker does not start anyone from an empty history.
    async #importLegacyStore() {
        if (this.imported) return;
        this.imported = true;
        if (this.#meta('kvImported', false) || !this.env?.JAVSTORE_SYNC) return;
        this.#setMeta('kvImported', true);
        try {
            const stored = await this.env.JAVSTORE_SYNC.get('state', 'json');
            if (stored && typeof stored === 'object') this.applyDocument(stored);
        } catch (error) {
            console.warn('Legacy KV document could not be imported.', error);
        }
    }

    async fetch(request) {
        await this.#importLegacyStore();

        if (request.method === 'GET') {
            return Response.json({ worker: WORKER_VERSION, state: this.document() });
        }
        if (request.method !== 'POST') {
            return Response.json({ error: 'Use GET to read or POST to sync.' }, { status: 405 });
        }

        let body;
        try {
            const text = await request.text();
            if (text.length > MAX_BODY_BYTES) {
                return Response.json({ error: 'The request is too large to sync.' }, { status: 413 });
            }
            body = JSON.parse(text);
        } catch (error) {
            return Response.json({ error: 'The request body is not JSON.' }, { status: 400 });
        }
        if (!body || typeof body !== 'object') {
            return Response.json({ error: 'The request carried nothing to sync.' }, { status: 400 });
        }

        if (body.state && typeof body.state === 'object') {
            this.applyDocument(body.state);
            return Response.json({ worker: WORKER_VERSION, state: this.document() });
        }
        return Response.json(this.sync(body));
    }
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

function fail(message, status, env) {
    return new Response(JSON.stringify({ error: message }), {
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
    if (!expected || presented.length !== expected.length) return false;
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
            return fail('The worker has no SYNC_TOKEN secret configured.', 500, env);
        }
        if (!tokenMatches(presentedToken(request), env.SYNC_TOKEN)) {
            return fail('Unauthorized.', 401, env);
        }
        if (!env?.SYNC_STORE) {
            return fail('The worker has no SYNC_STORE Durable Object binding.', 500, env);
        }

        const store = env.SYNC_STORE.get(env.SYNC_STORE.idFromName(OBJECT_NAME));
        const answer = await store.fetch(request);
        const headers = new Headers(answer.headers);
        headers.set('Cache-Control', 'no-store');
        for (const [name, value] of Object.entries(corsHeaders(env))) headers.set(name, value);
        return new Response(answer.body, { status: answer.status, headers });
    },
};
