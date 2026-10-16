# WVC-0 WebSocket Client Build and Asset Spike Results

> Status: Completed and Archived — bounded Provisional Pass accepted
> Date: 2026-10-12
> Owner: Project owner
> Specification: [WVC-0 Spike Specification](wvc-0-spike-specification.md)
> Consumed by: [Migration Specification](specification.md)
> Confirmation: Owner confirmed the bounded Results on 2026-10-12. This completes WVC-0 but does not authorize production Delivery.

## 1. Conclusion

The hypothesis passed provisionally.

One Vite dist built with `base: './'` can serve `/`, `/chat`,
`/nested/chat`, and `/chat2.html` by deriving exact asset routes from each HTML
route's URL directory. All routes loaded the same JS bytes. The alias received
a different runtime Theme hint through one JSON token without creating another
bundle.

A validated recursive dist inventory was sufficient. No Vite manifest was
needed for the fixture: all regular files below dist were preloaded into an
exact in-memory map, request paths never became filesystem paths, and every
packaged HTML reference was present and retrievable.

The source-free target contained only dist, the disposable HTTP smoke, and a
package manifest. It passed without Vue, Vite, Client source, or build tools in
that target. This supports the proposed Source-loaded and Built consumption
contract.

## 2. Environment

| Fact | Value |
|---|---|
| Required project Node line | `22.x` |
| Evidence Node | `22.23.3` through disposable `node@22` |
| Shell default Node | `20.16.0`; not used for final evidence |
| npm | `10.8.1` |
| Vue | `3.5.22` |
| Vite | `6.4.1` |
| `@vitejs/plugin-vue` | `5.2.4` |
| Fixture location | Session disposable files area, outside repository source |

The initial probe under the shell's Node 20 also passed, but it is not relied
on because the product manifest requires Node 22.

Disposable install reported three high-severity advisories in the selected
build-only fixture dependency graph. Those dependencies were not added to the
repository. Production Delivery must select current compatible versions and
run the repository's normal dependency audit before acceptance.

## 3. Commands

Representative final-evidence commands:

```text
npm install --ignore-scripts
npx -y node@22 node_modules\vite\bin\vite.js build
npx -y node@22 smoke.mjs
```

Vite emitted:

```text
client/dist/index.html
client/dist/assets/index-CY1DqBnc.css
client/dist/assets/index-DSYz04iF.js
```

The built HTML retained exactly one:

```text
__MY_AGENT_CLIENT_CONFIG_JSON__
```

and used:

```text
./assets/index-CY1DqBnc.css
./assets/index-DSYz04iF.js
```

## 4. Evidence

| ID | Result | Observation |
|---|---|---|
| WVC0-01 | Pass | Vite produced one HTML, one hashed CSS, and one hashed JS with no CDN or source map |
| WVC0-02 | Pass | Exactly one JSON token survived build; replacement parsed as `/ws` plus validated `default`/`alternative` Theme |
| WVC0-03 | Pass | `/` returned HTML; `/assets/*` returned referenced JS/CSS with expected MIME and cache policy |
| WVC0-04 | Pass | `/chat` resolved `./assets/*` to the same `/assets/*` bytes |
| WVC0-05 | Pass | `/nested/chat` resolved assets to `/nested/assets/*` and loaded the same bundle bytes |
| WVC0-06 | Pass | `/chat2.html` loaded the same bundle hash and received `alternative` rather than `default` |
| WVC0-07 | Pass | Exact map lookup returned 404 for unknown path, encoded traversal, and unsupported method |
| WVC0-08 | Pass | HTML used `no-store`; hashed assets used immutable cache; HEAD returned headers and no body |
| WVC0-09 | Pass | Copied dist passed in a source-free target without Client source, Vue, Vite, or build tools |
| WVC0-10 | Pass | `npm pack --dry-run --json` contained every dist file and installed-style smoke fetched every HTML reference |
| WVC0-11 | Pass | Recursive inventory is sufficient; manifest adds no value for the current static output |
| WVC0-12 | Pass | Concrete build/prepack and Source-loaded command graph is recorded below |

All four routes loaded JS with SHA-256:

```text
7495692684608d4c8e9321b2e466a17abb820b3f71c9398a1bdb8b8eacd81895
```

The exact registered asset paths were:

```text
/assets/index-CY1DqBnc.css
/assets/index-DSYz04iF.js
/nested/assets/index-CY1DqBnc.css
/nested/assets/index-DSYz04iF.js
```

Duplicate registrations were accepted only when bytes were identical.
Production startup must fail on an asset-path collision with different bytes
or with an HTML/WebSocket route.

## 5. Selected design

### 5.1 Asset URLs

Select:

```text
Vite base: './'
+ route-directory asset derivation
+ exact in-memory path map
```

For each configured HTML route, resolve every dist asset exactly as a browser
resolves `./<dist-relative-path>` from that route. This naturally supports
file-like and nested Client paths and permits multiple HTML routes to share
bytes.

Do not introduce a new fixed public asset prefix or HTML asset-base rewrite
unless production evidence later falsifies this result.

### 5.2 Inventory

Select recursive dist inventory rather than Vite manifest:

- accept only regular files under the resolved dist root;
- reject symlinks and unsupported entries;
- reject source maps from production inventory;
- preload content before readiness;
- map requests only by exact registered URL;
- detect route collisions before listener readiness.

Manifest remains unnecessary while the complete bounded dist is inventoried.

### 5.3 Runtime config

Keep:

```html
<script id="my-agent-client-config" type="application/json">
  __MY_AGENT_CLIENT_CONFIG_JSON__
</script>
```

Require exactly one token in built HTML, replace it per HTML route with
script-safe JSON, and validate it at Client bootstrap.

### 5.4 Dependency classification

Candidate Extension manifest classification:

```text
dependencies:
  ws

devDependencies:
  vue
  marked
  vite
  @vitejs/plugin-vue
  vue-tsc
```

Vue and marked are build inputs bundled into dist; installed Extension runtime
does not resolve them. Production Delivery must choose current compatible
versions and update the lockfile through the normal package-manager flow.

## 6. Command graph recommendation

Candidate Extension scripts:

```text
build:client
  -> vite build

verify:client
  -> verify token count, dist inventory, HTML references, and forbidden maps
```

Candidate root scripts:

```text
build:client
  -> npm run build:client --workspace @my-agent/websocket-channel

verify:websocket-client
  -> npm run verify:client --workspace @my-agent/websocket-channel

prepare:websocket-client
  -> build:client
  -> verify:websocket-client

preagent
  -> prepare:websocket-client

build
  -> existing root dist cleanup
  -> prepare:websocket-client
  -> existing TypeScript/Host/audit build

prepack
  -> existing root build
```

Source-loaded copy/staging calls `prepare:websocket-client` before copying
server source plus `client/dist`. Extension load and Channel start only validate
and read dist; they never invoke these commands.

## 7. Package verification recommendation

Update the root package allowlist from individual Client HTML files to the
Client dist directory. Package audit should:

1. require `client/dist/index.html`;
2. inventory all tarball files below `client/dist`;
3. extract runtime `src`/`href` references from packaged HTML;
4. resolve them using the selected relative-base rule;
5. require the corresponding dist-relative files;
6. reject source maps and unexpected Client source.

Installed-package smoke should request each configured HTML route, extract its
runtime references, resolve them against the response URL, fetch every asset,
and verify MIME/cache behavior plus absence of the config token.

## 8. ADR assessment

No new ADR is recommended.

ADR-015 already decides that the WebSocket Extension owns its HTML Client,
resources, tests, dependencies, and installed-package static assets. Moving
from two inline HTML resources to one prebuilt bounded resource set refines
that accepted ownership without changing dependency direction, public Runtime
authority, or Channel composition.

The Migration Specification is sufficient if Delivery stays within these
boundaries. A new ADR is required only if implementation introduces a durable
cross-Extension frontend platform, a public asset namespace shared by other
modules, or a new resource owner.

## 9. Limitations

- The fixture proved build, URL, HTTP, package, and config parsing behavior; it
  did not migrate or browser-test the real Chat UI.
- It did not define Built server compilation.
- It did not test dynamic imports. Recursive inventory would serve their files,
  but production Client-path behavior must remain covered if dynamic imports
  are introduced.
- The fixture used provisional `default`/`alternative` IDs. After accepting
  these Results, the owner selected production names Classic (`classic`) and
  Botanical (`botanical`) and chose to remove `/chat2.html` without an alias.
  Production Client config therefore needs only `webSocketPath`; Theme default
  and preference are Client-owned.

## 10. Repository cleanliness

The fixture, dependencies, dist, and source-free target remained under the
session disposable directory. Repository `package.json`, lockfile, Extension
package manifest, and production source were unchanged by the Spike.
