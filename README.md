# suko-registry

Extension registry for Suko CMS Core v2. A plain GitHub repo serves as the
default extension store: an index (`registry.json`), declarative manifests,
and code-extension source distributions. The CMS fetches it over
`raw.githubusercontent.com` — no API server required.

This is the default registry a fresh Suko CMS instance points at
(`core.registrySources`); see "Running your own registry" below to host a
fork or a private alternative.

## Layout

```
registry/
  registry.json                # index of all extensions
  schema/manifest.schema.json  # JSON Schema (draft 2020-12) for declarative manifests
  extensions/
    gallery/manifest.json      # declarative extension example
    blog/
      manifest.json            # code extension metadata stub
      files/                   # full source tree, copied into extensions/<id>/ by the CLI
  README.md
```

## `registry.json` format

Top-level `extensions` array. Each entry:

```json
{
  "id": "gallery",
  "kind": "declarative",
  "name": "Gallery",
  "version": "1.0.0",
  "coreApi": "^1.0.0",
  "description": "...",
  "author": "kuosuko"
}
```

- `id` — matches `^[a-z][a-z0-9-]{1,30}$`, unique within the registry.
- `kind` — `"declarative"` or `"code"`.
- `version` — exact semver of the published manifest.
- `coreApi` — semver range (`^x.y.z`, `~x.y.z`, exact, or `>=x.y.z`) checked
  against the installing CMS's `CORE_API_VERSION`.

## Manifest format

Declarative manifests (`extensions/<id>/manifest.json` where `kind` is
`"declarative"`) must validate against
[`schema/manifest.schema.json`](./schema/manifest.schema.json), which mirrors
the zod schema in the CMS at `src/ext/dx/manifest.ts`. See the schema file and
`extensions/gallery/manifest.json` for the full shape: `contentTypes` (field
types `text | richtext | number | boolean | date | media | select | slug |
json`), `settings` (same `SettingField` shape as code extensions),
`adminPages` (collection views), `publicRoutes` (`list` / `detail` views,
segment-only patterns — no regex), and `on` (hook name → webhook action
bindings, https-only, HMAC-signed).

Code extensions (`kind: "code"`) publish a metadata-only manifest plus a
`files/` directory containing the full source tree to copy into the
installing project's `extensions/<id>/` directory.

## How the CMS fetches this registry

The CMS reads the setting `core.registrySources` — a JSON array of base URLs,
defaulting to:

```
https://raw.githubusercontent.com/sz-ws/registry/main
```

For each configured source, it fetches:

- `<base>/registry.json` — to list available extensions (admin `Browse` tab).
- `<base>/extensions/<id>/manifest.json` — to install a specific extension.

Fetches are https-only, restricted to configured sources (no arbitrary URLs
from a request), capped at 1 MB, and JSON-parsed inside a try/catch.

## Declarative vs. code installs

| | Declarative | Code |
|---|---|---|
| Ships | JSON manifest only | Manifest + source files |
| Install | Runtime, via admin UI (`POST /api/registry/install`) | Compile-time: `npx @sz.ws/cms add <id>`, then rebuild |
| Storage | Row in `declarative_extensions`, interpreted per-request | Registered in the code extension loader at build time |
| Validation | zod-validated at install AND at interpret time | zod-validated by `defineExtension()` at load time |
| Custom code / providers | Not supported | Supported (`provides`, arbitrary handlers) |

The admin `Browse` tab shows an Install/Update button for declarative
entries; code entries show the `npx @sz.ws/cms add <id>` command to copy instead,
with install disabled from the UI.

## Running your own registry

1. Fork this repo (or copy the `registry/` directory into your own repo).
2. Add/edit entries in `registry.json` and their corresponding
   `extensions/<id>/manifest.json` (and `files/` for code extensions).
3. In your CMS instance, set `core.registrySources` (admin settings) to
   include your fork's raw base URL, e.g.:
   `https://raw.githubusercontent.com/<you>/<your-fork>/main`
4. Keep manifests valid against `schema/manifest.schema.json` — the CMS
   re-validates on every install and interpret, so invalid manifests are
   rejected rather than silently accepted.

## Selling extensions (registry protocol 1)

This registry is a static GitHub repo: it cannot tell sites apart, so it
lists free extensions only and publishes no notices. A registry that sells
extensions needs a server in front of its files that checks each site's key
before it sends manifests or source — the check lives where the bytes are
served. The CMS shows the price and sends the site owner to the operator;
it never takes payments or checks licences itself. A registry without such a
server keeps working unchanged.

### Protocol header

The CMS and the `@sz.ws/cms` CLI send `X-Registry-Protocol: 1` on every
registry request, next to the usual `Authorization: token <t>`. List
extensions a key has not been given, and answer 402, only to requests that
carry the header. Answer the rest as before (leave them out, 404), so an
older site never shows an install button that fails when pressed.

### Index fields

```json
{
  "extensions": [
    {
      "id": "session-replay",
      "kind": "declarative",
      "name": "Session replay",
      "version": "0.1.0",
      "coreApi": "^1.48.0",
      "description": "See how visitors scroll, where they click, and where they stop.",
      "support": { "url": "https://registry.example.com/contact" },
      "offer": {
        "price": { "amount": 250, "currency": "USD", "period": "year" },
        "note": "Per site, setup included",
        "action": "request",
        "termsUrl": "https://registry.example.com/terms"
      },
      "access": "locked"
    }
  ],
  "notices": []
}
```

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `offer` | object, optional | operator (in the repo) | No `offer` = free |
| `offer.price.amount` | number ≥ 0 | | In the currency's main unit (TWD: dollars) |
| `offer.price.currency` | ISO 4217 code | | Shown as is; the CMS does not convert |
| `offer.price.period` | `once` / `month` / `year` | | |
| `offer.price` | optional as a whole | | An offer may carry only a `note` ("quoted per seat") |
| `offer.note` | string or `{ "en", "zh-Hant" }`, ≤ 40 characters | | Unit and what is included |
| `offer.action` | `request` / `link` / omitted | | Omitted: the store shows the price and the entry's `support` contact |
| `offer.url` | https | | Required with `action: "link"` |
| `offer.termsUrl` | https, optional | | Adds a Terms row to the store page |
| `access` | `granted` / `locked` / `requested` / `expired` | server, per key | Without `access` the CMS ignores `offer` |
| `accessUntil` | ISO date, optional | server | Last day of access; a past date with `expired` |
| `requestedAt` | ISO date, required with `requested` | server | When the site asked |

- **`offer` counts only next to `access`.** A registry that cannot send
  `access` (a static one) shows its entries as free, so nothing looks paid
  but installs anyway.
- **The CMS words every button and status.** A registry supplies numbers
  and the note, never button text.
- **An offer that breaks any rule is dropped whole** (non-https URL,
  currency that is not three capital letters, unknown period or action,
  note over 40 characters, `link` without `url`). If `access` is still
  `locked`, the store still says the extension is not activated.
- **Text is plain text.** The CMS and the CLI remove control characters and
  ANSI escape sequences from `note`, notice text and the 402 `message`
  before showing them, then cut `message` to 200 characters. HTML and
  Markdown are shown as typed.
- **Amounts use the `en` locale** whatever the admin language:
  `NT$25,000`, `¥3,000`, `$12`, `$12.50`.
- `access`, `accessUntil` and `requestedAt` are added by the server for the
  key making the request; they never go in the repo.
- `coreApi` states what the manifest needs; a price does not change it.

### Errors: 401 / 403 versus 402

| Status | Meaning | Scope | What the site shows |
|---|---|---|---|
| 401 / 403 | The key itself is missing, unknown or revoked | The whole source | The key for this source no longer works; ask the provider |
| 402 `{ "error": "not_entitled", "message": "…" }` | This key has not been given this extension | One extension | Not activated, plus `message` |

Keep expiry on each extension a key has been given, not on the key. An
expired key makes the whole index unreadable, free and granted extensions
included.

### What the server answers (with the protocol header)

| Request | Not given | Requested | Given | Expired | Private, not listed |
|---|---|---|---|---|---|
| `registry.json` | `access: "locked"` | `requested` + `requestedAt` | `granted` (+ `accessUntil`) | `expired` + `accessUntil` | left out |
| Store images (icon, banner, screenshots) | 200 | 200 | 200 | 200 | 404 |
| `manifest.json`, `files/*` | 402 | 402 | 200 | 402 | 404 |

An extension with an `offer` is already public in the index, so a 402 that
names the reason gives nothing away. Extensions you do not list keep
answering 404.

A site decides by `(source, id)`: another source listing the same id does
not update an installed extension, and replacing it takes an explicit
confirmation from the site's admin.

Once files reach a site they are the site's: expiry stops installs and
updates, not what is already installed. Anything that must stop when a
subscription ends belongs on the operator's own server, with the extension
as the client.

### Requests

```
POST <source>/requests
Authorization: token <the source's token>
X-Registry-Protocol: 1
Content-Type: application/json

{ "extension": "session-replay",
  "note": "We'd like to try it for a month",
  "contact": { "name": "Jane Doe", "email": "owner@example.com" } }
```

- Answers: `202 { "message"?: "…" }`, `409 already_granted`, `404` (this
  registry takes no requests in-site; the store falls back to the contact
  link), `413`, `429`.
- `contact` is sent only when the site owner ticks it.
- Limits the server must enforce (a site's own limit can be removed):
  one open request per key and extension, where a repeat updates the note
  without notifying again; at most 10 new requests per key per day (429);
  `note` ≤ 500 characters and body ≤ 4 KB (413). Notify the operator only
  when a request becomes pending.
- After a request the site reads the index again: `requested` shows as
  requested; granting turns it into `granted`; declining returns it to
  `locked`, and the site can ask again.

With `action: "link"` the store opens `offer.url` in a new tab instead and
adds nothing to it. A key-specific index can carry a key-specific URL.

### Notices

A top-level `notices` array announces new extensions. Sites receive them
only after switching them on for that source; they are off by default.

```json
"notices": [
  {
    "id": "2026-10-session-replay",
    "title": "New: session replay",
    "body": "See how visitors scroll, where they click, and where they stop.",
    "extension": "session-replay",
    "publishedAt": "2026-10-01",
    "expiresAt": "2026-11-01"
  }
]
```

| Field | Meaning |
|---|---|
| `id` | `[a-z0-9-]{1,64}`, unique within the source; a site remembers which ids it has shown |
| `title` | ≤ 40 characters, plain text, may be `{ "en", "zh-Hant" }` |
| `body` | ≤ 200 characters, plain text, may be `{ "en", "zh-Hant" }` |
| `extension` | Required. An extension in the same index; the notice opens its store page and uses its banner. A notice pointing elsewhere is dropped |
| `publishedAt` / `expiresAt` | Not shown before or after |

Notices carry no external URL. Each admin sees a notice once, at most one
a day, and never one published before the site switched notices on. The
server may send different notices to different keys.

### CMS support

The store reads `offer` and `access`, shows the price, and for any
extension a key has not been given offers a contact button that opens the
entry's `support.url` (or `support.email`). A 402 shows as not activated
with the server's message; the CLI stops with exit code 11. In-site
requests, `action: "link"` and notices are not in the store yet: a server
can already send them, and sites ignore what they do not read (a
`requested` or `expired` entry shows like `locked`).
