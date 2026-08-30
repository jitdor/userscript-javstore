# JavStore sync worker

A single-user Cloudflare Worker that keeps the userscript's settings and visited history in
a Durable Object, so the history survives a userscript-manager reinstall and follows you
between devices.

One object, one bearer token. Anyone with that token can read and write the whole history,
so treat it like a password.

## Why a Durable Object

A Durable Object is single-threaded and strongly consistent, so the read-merge-write each
sync performs is serialized: two devices syncing in the same second queue behind one another
instead of both merging into the same stale base. Its storage is SQLite, so history is rows
rather than one blob, and devices exchange only what changed — an idle page load costs about
**150 bytes** each way, against roughly **450 KB** for a full history under the old
whole-document protocol.

## Deploy

```sh
cd worker
npx wrangler login
openssl rand -base64 32              # your access token — keep a copy
npx wrangler secret put SYNC_TOKEN   # paste the token when prompted
npx wrangler deploy
```

No namespace to create and nothing to paste into `wrangler.toml`.

`workers_dev = false` is set, so the worker has **no `*.workers.dev` URL**: those subdomains
are guessable, and the history behind this one is worth not advertising. Give it a route on a
domain you own instead — uncomment `routes` in `wrangler.toml` and point it at a hostname in
a zone on the same Cloudflare account:

```toml
routes = [
    { pattern = "sync.example.com", custom_domain = true },
]
```

Deploying with `workers_dev = false` and no route leaves the worker unreachable. If you would
rather use the free subdomain, comment `workers_dev` out and `wrangler deploy` prints the URL,
e.g. `https://javstore-sync.<subdomain>.workers.dev`.

## Point the userscript at it

Open the `JVS` panel on JavStore → **Cloud sync**:

- **Worker endpoint** — your route, or the URL from `wrangler deploy` (any path works;
  `/state` reads well). Changing the endpoint later is safe: the device notices it is a
  different worker and re-uploads its history in full.
- **Access token** — the token you generated.
- Tick **Sync to my Cloudflare Worker**, then **Save sync settings**.

Repeat on every device with the same URL and token. Each device syncs on load, when its tab
regains focus, a few seconds after a visit, on the interval you set, and on **Sync now**.

## Upgrading from the KV version

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml`, fill in your old namespace id and
deploy. The worker imports that document into the Durable Object on its first request, once.
After a sync you can delete the binding and the namespace.

Devices still running 6.2.0 keep working against this worker — it answers the old
whole-document protocol as well — and a 6.3.0 device falls back to that protocol if it finds
an old worker, so the two can be upgraded in either order.

## API

Every route requires `Authorization: Bearer <SYNC_TOKEN>`; the path is ignored.

| Method | Body | Answer |
| --- | --- | --- |
| `GET` | — | `{ "state": <whole document> }`, for backups |
| `POST` | `{ cursor, meta, changes[], limit? }` | `{ cursor, more, meta, changes[] }` |
| `POST` | `{ "state": <document> }` (6.2.0 clients) | `{ "state": <whole document> }` |
| `OPTIONS` | — | CORS preflight |

A delta `POST` hands over the entries the device has touched since its last push and asks
for everything recorded after `cursor`. Entries are last-writer-wins on their own event
timestamp, with a deletion winning a tie; `resetAt` and `prunedBefore` in `meta` are horizons
below which nothing survives. A device that pushes an entry older than the stored one is
handed the winner back, so it cannot stay wrong about it.

The object keeps up to 50,000 visited entries (a device keeps its newest 5,000) and expires
tombstones after 90 days.

## Notes

- Costs nothing in practice: a sync is one object request, and idle syncs move a few hundred
  bytes. SQLite-backed Durable Objects are free-plan eligible — check Cloudflare's current
  limits if you sync unusually often.
- Rotating the token: `npx wrangler secret put SYNC_TOKEN`, then update it in the panel on
  each device.
- Backing up the history:
  `curl -H "Authorization: Bearer $TOKEN" https://<your-worker>/state > backup.json`.
  That file is also a valid **Import backup** file for the panel.
