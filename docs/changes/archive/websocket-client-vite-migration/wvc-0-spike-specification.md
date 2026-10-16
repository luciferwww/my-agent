# WVC-0 WebSocket Client Build and Asset Spike

> Status: Completed and Archived
> Date: 2026-10-12
> Owner: Project owner
> Decision unlocked: [Migration Specification](specification.md) build, asset-path, package, and Source-loaded preparation contract
> Authorization: Owner selected the Active Change plus prerequisite Spike path on 2026-10-12. This authorizes disposable evidence collection only.
> Results: [Accepted bounded Results](wvc-0-spike-results.md)

## Decision question

Can one prebuilt Vue 3/Vite Client dist be safely and predictably consumed by
Source-loaded and Built WebSocket Extensions across configurable Client paths,
runtime JSON configuration injection, and npm package verification without any
install/load/start-time build?

## Falsifiable hypothesis

A minimal Vue 3/Vite fixture can produce one dist that:

1. preserves exactly one `__MY_AGENT_CLIENT_CONFIG_JSON__` token in built HTML;
2. serves the same JS/CSS under `/`, `/chat`, `/nested/chat`, and a Theme alias
   using one explicit URL mapping strategy;
3. can be inventoried into a bounded asset map without request-time filesystem
   path concatenation;
4. can be copied and run with Client source and build tools absent;
5. can be fully verified by package inventory and an installed-style HTTP
   smoke that follows HTML asset references.

Failure of any item blocks the corresponding candidate design and requires the
Results to recommend another strategy before production Delivery.

## Scope and non-goals

In scope:

- disposable minimal Vue SFC and Vite build;
- HTML runtime JSON token preservation and replacement;
- route-relative, stable-prefix, or rewrite asset-path comparison;
- controlled dist inventory and optional manifest comparison;
- MIME, cache, GET/HEAD, unknown-path, and traversal behavior;
- Source-loaded preparation and source-free runtime fixture;
- package inventory and installed-style asset fetch.

Non-goals:

- migrating production `chat.html` or `chat2.html`;
- reproducing full Chat UX or WebSocket protocol;
- production manifest, script, loader, or Channel edits;
- Theme visual design;
- Built server compilation;
- Subagent Observation or Automation;
- performance benchmarking beyond bounded startup/build observations.

## Method

1. Create the fixture only under the session artifact/temp area or another
   disposable directory outside production source.
2. Use Node 22 and the repository package manager. Record exact package and
   tool versions.
3. Install only the minimal fixture dependencies required for Vue SFC and Vite
   build; do not modify repository manifests or lockfiles.
4. Build a page containing:
   - one Vue component;
   - one CSS asset;
   - the exact Client config JSON placeholder;
   - a visible rendering of validated `webSocketPath` and `initialTheme`.
5. Test each candidate asset strategy against `/`, `/chat`, `/nested/chat`,
   and `/chat2.html`. Record the generated HTML URLs and registered HTTP paths.
6. Implement a disposable in-memory asset map. Resolve requests only by exact
   map lookup, not by joining request paths to disk.
7. Exercise GET, HEAD, unknown method/path, encoded traversal, MIME, and cache
   scenarios.
8. Copy only dist plus the disposable server fixture to a clean target, remove
   Client source/build tools from that target, and rerun the HTTP smoke.
9. Produce a tarball-style inventory and verify every script/link asset
   referenced by HTML can be fetched.
10. Record results in `wvc-0-spike-results.md`, clean disposable processes and
    unneeded temporary files, and identify the selected or rejected strategy.

The Spike may use a small disposable Node HTTP server. It must not import
production `WebSocketChannel` or create an alternate production path.

## Required evidence

| ID | Scenario | Required observation |
|---|---|---|
| WVC0-01 | Vite build | Exact output inventory, versions, build command, no CDN reference |
| WVC0-02 | Runtime config token | Exactly one token survives build; safe JSON replacement parses and validates |
| WVC0-03 | Root route | HTML and every referenced asset resolve with expected status and MIME |
| WVC0-04 | File-like route `/chat` | Selected URL strategy resolves every asset without fallback |
| WVC0-05 | Nested route `/nested/chat` | Selected URL strategy resolves every asset without fallback |
| WVC0-06 | `/chat2.html` alias | Same bundle loads with a distinct initial Theme hint |
| WVC0-07 | Asset map safety | Unknown, traversal, and unsupported-method requests cannot read files |
| WVC0-08 | HTTP semantics | GET/HEAD bodies, Content-Type, no-store HTML, and immutable hash caching are correct |
| WVC0-09 | Source-free target | Dist runs after Client source and build tools are omitted |
| WVC0-10 | Package inventory | Every HTML runtime reference exists and installed-style smoke fetches it |
| WVC0-11 | Strategy comparison | Results explain why inventory/manifest and asset URL candidates were selected or rejected |
| WVC0-12 | Build integration | Concrete root build/prepack and Source-loaded preparation command graph |

## Success, failure, and stop conditions

Success requires all WVC0-01 through WVC0-12 evidence and one recommended
asset-path plus inventory strategy with no runtime build.

Failure is recorded if no tested strategy supports all required Client paths,
the config token cannot survive normal Vite build, source-free runtime requires
build dependencies, or bounded asset serving cannot be demonstrated.

Stop immediately if the experiment would require:

- editing production source or repository dependency manifests;
- weakening existing Client/WebSocket path validation;
- network credentials or external service access;
- an unbounded filesystem mapping;
- changing public protocol or Extension behavior.

## Constraints and safety

- No credentials, user data, Agent transcripts, or external APIs.
- Network package download is limited to public fixture dependencies and only
  if not already available locally.
- No production server port; bind only an ephemeral loopback port.
- No detached processes.
- No repository lockfile or production dependency mutation.
- No production implementation authority.
- Remove disposable build/install data after recording evidence unless it is a
  requested session artifact.

## Deliverables

1. `wvc-0-spike-results.md` with commands, versions, evidence table, selected
   strategy, failures, and bounded conclusions.
2. Any small reusable evidence fixture only if the owner explicitly decides it
   should remain; otherwise clean it.
3. Revised Draft Specification consuming the evidence.
4. A recommendation on ADR need and whether WVC-1 is Ready for owner review.
