# JavStore sync worker

A single-user Cloudflare Worker that keeps the userscript's settings and visited history in
a KV namespace, so the history survives a userscript-manager reinstall and follows you
between devices.

The worker holds **one** document and guards it with **one** bearer token. Anyone with that
token can read and write the whole history, so treat it like a password.

## Deploy

```sh
cd worker
npx wrangler login
npx wrangler kv namespace create JAVSTORE_SYNC   # paste the printed id into wrangler.toml
openssl rand -base64 32                          # your access token — keep a copy
npx wrangler secret put SYNC_TOKEN               # paste the token when prompted
npx wrangler deploy
```

`wrangler deploy` prints the worker URL, e.g. `https://javstore-sync.<subdomain>.workers.dev`.

## Point the userscript at it

Open the `JVS` panel on JavStore → **Cloud sync**:

- **Worker endpoint** — the URL from `wrangler deploy` (any path works; `/state` reads well).
- **Access token** — the token you generated.
- Tick **Sync to my Cloudflare Worker**, then **Save sync settings**.

Repeat on every device with the same URL and token. Each device syncs on load, when its tab
regains focus, a few seconds after a visit is recorded, on the interval you set, and
whenever you press **Sync now**.

## API

Both routes require `Authorization: Bearer <SYNC_TOKEN>`; the path is ignored.

| Method | Body | Answer |
| --- | --- | --- |
| `GET` | — | `{ "state": <document> }` as stored |
| `POST` | `{ "state": <document> }` (a bare document is accepted too) | `{ "state": <merged document> }` |
| `OPTIONS` | — | CORS preflight |

`POST` merges rather than replaces, using the userscript's rules: newest timestamp wins per
URL, a tombstone (`v|<url>` for a visit, `o|<url>` for an override) outranks an entry of the
same age or older, and `resetAt`/`prunedBefore` are horizons below which nothing survives.
A device that has been offline for a week therefore cannot overwrite what the others
recorded, and "Clear visited history" propagates instead of being undone.

The stored document is capped like the local one: 5,000 visited URLs and 2,000 tombstones,
oldest dropped first, with tombstones expiring after 90 days.

## Notes

- KV is eventually consistent, so two devices syncing in the same second can both read the
  same version and one write can land on top of the other. Nothing is lost for long: every
  device pushes its complete document on every sync, so the next sync restores it.
- Costs nothing in practice — a sync is one KV read, plus one write only when something
  actually changed, so ordinary page loads stay well inside the free tier.
- Rotating the token: `npx wrangler secret put SYNC_TOKEN`, then update the token in the
  panel on each device.
- Reading the raw document: `npx wrangler kv key get --binding JAVSTORE_SYNC state --remote`.
