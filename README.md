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
