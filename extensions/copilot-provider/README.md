# Copilot provider experiment

## Account management entry point

Run this extension's own command from the **my-agent repository root** (the
directory containing the root `package.json`, not its parent workspace):

```powershell
npm run start --workspace @my-agent/copilot-provider
```

Build once before the first run, and rebuild after source changes, as described
under **Run independently** below.

This command is the standalone entry point for **signing in and signing out**. Saved
sign-ins are checked automatically when you open the page. It starts the extension's local server and
opens its account management page. It does not start the Agent host, and the
host does not need to be running. No extension-specific host API or Settings
button is required or provided.

The **local page**, not GitHub, has one main button which follows account state:

| Account state | Main button and action |
| --- | --- |
| Not connected or reauthorization required | **Sign in with GitHub** requests a device code and displays the authorization steps |
| Signing in or checking a saved sign-in | **Cancel** stops the operation without removing an existing credential |
| Connected (or a saved sign-in needs attention) | **Sign out** removes this extension's saved credential from this device |
| Saving, signing out or cancelling | A disabled progress label prevents conflicting actions |

There are no separate **Check saved login** or **Cancel login** buttons.
The authorization steps appear only when there is a device code to enter;
after connection they disappear and a green connected status is shown.

Keep the launching terminal running while using the page. Closing the last
local page cancels an unfinished operation but leaves the local server running.
To return to the controls, reopen the private URL printed in that terminal.
If the server has stopped, run the command again; the same operating-system user's saved
experiment credential is checked automatically. You do not need to sign in again
after a successful check.
Stop an existing launcher with Ctrl+C before starting another instance.

This npm workspace command is a development entry point, not a globally
installed `copilot-provider` executable. It manages the account; model discovery
and inference run through the host provider described below.

## Experiment specification

Status: Experimental. Local regressions, account-page smoke, saved-account
catalog reads and one authorized native inference passed. The owner also
confirmed manual host testing after the sign-in cancellation fix.

The owner initially approved an isolated authentication spike on 2026-11-19:
preserve the existing Copilot Relay and use an extension-owned
local page rather than modifying the host or WebSocket Settings UI. The approved
interaction now shows the device code and URL on that page, without a CLI window.
The owner subsequently approved extension-owned model discovery: a catalog query
may open sign-in when required, including the first automatic query after startup.
The host cannot distinguish interactive from background catalog reads, so other
catalog queries may also trigger sign-in. Registration itself remains inert.
The owner then approved native inference in the new extension while keeping the
host and existing Relay unchanged. The protocol clients and model-metadata
parser are adapted copies of the existing Relay extension's implementations,
not a second independently designed protocol stack. This experiment remains
independently loadable and does not import another extension's private files.

**Question:** Can an independent provider extension own the interaction
`model query or invocation -> sign-in if needed -> authenticated Copilot request`,
without Copilot-specific host authentication code?

This is disposable experimental code, not an accepted production authentication
contract. It does not validate integration into the existing Settings UI.
The host currently has no extension-contributed Settings action interface.

## Run independently

From the repository root:

```powershell
npm run build --workspace @my-agent/copilot-provider
npm run start --workspace @my-agent/copilot-provider
```

Requires Node.js 22. Browser mode supports Windows, macOS and Linux desktops:
Windows uses `rundll32.exe`, macOS uses `open`, and Linux uses `xdg-open`
(usually provided by `xdg-utils`). A default browser is required for this mode.
No PowerShell, SDK, new npm dependencies, relay HTTP server, existing Relay
credentials, or Copilot CLI installation is required. Headless systems can use
the terminal mode below.

The launcher prints a private loopback URL and opens it in your browser.

1. The initial page explains why to connect and shows one account button.
   With no saved sign-in it makes no GitHub request until you choose to sign in.
   If credentials exist, it automatically checks current Copilot access.
2. Click **Sign in with GitHub**. A code and clickable GitHub URL appear on this
   page. Select **Copy code**, then click the URL to open GitHub in a new tab.
   Enter the code **on GitHub** and approve access with the intended account.
   The page does not redirect or automatically open GitHub.
3. The extension verifies a Copilot token exchange before saving the GitHub
   credential. **Verified** does not mean any particular model or inference works.
4. The same main button becomes **Cancel** during authorization. Use it to stop
   waiting and hide the code.
   Closing the last local login page also cancels unfinished authorization.
   Closing the GitHub tab does not cancel the attempt. Expired and completed
   attempts also hide the old code; signing in again requests a fresh one.
   A failed/cancelled attempt must not replace a previously saved credential.
5. After connection, the main button becomes **Sign out**. Clicking it removes
   the local credential and returns to **Sign in with GitHub**. This does not
   revoke the GitHub OAuth grant or sign you out of GitHub itself.
   Reopening the page automatically verifies saved access; there is no manual
   check button. A stored credential alone is not treated as verified.
6. Stop the launcher with Ctrl+C to stop the server. Closing the last local
   page cancels its unfinished operation but does not stop the server.

No CLI window is launched. If clipboard access fails, the page explicitly asks
you to select and copy the displayed code manually. After a page reload, the
same browser tab keeps the page-access key in
sessionStorage. Reloading may cancel an in-progress attempt as its connection
closes; sign in again if that happens. If the key is lost, reopen the original
launcher URL.

### Headless Linux, Docker and SSH

Run on the machine/container where the host will run, as the same operating-system
user:

```sh
npm run start --workspace @my-agent/copilot-provider -- --device-code
```

This mode prints GitHub's verification URL and user-facing device code without
starting a local web server or opening a browser. Open the URL on another
computer or phone and enter the code. The command polls GitHub, verifies Copilot
access, saves the credential on the original host and exits. Ctrl+C cancels it
without replacing the saved credential. The terminal never prints account tokens.

Then start the Agent host, or retry a previously failed model query. There is no
automatic switch from browser mode to terminal mode; a browser-launch failure
reports the terminal command explicitly. Do not run competing login/sign-out
operations against the same credential file.

In containers, persist the credential directory with a private volume and keep
the same user/home directory across restarts. Do not bake credentials into an image
or share the volume with untrusted users.

## Host provider

The independent command remains available for explicit account management.
The host loads this installed extension and registers its provider by default,
using ordinary extension enablement. It does not add a Settings button or
require the independent launcher to be running.
Stop the independent launcher before testing the host integration; simultaneous
instances sharing the credential file are unsupported.

To explicitly enable the extension, merge this into your Agent Home configuration:

```json
{
  "extensions": {
    "entries": {
      "copilot-provider": {
        "enabled": true
      }
    }
  }
}
```

Set `enabled` to `false` to prevent the host from loading the extension.
No provider-specific enablement flag is needed. Remove any older `config.active`
field from the entry; that experimental flag is no longer accepted.

Restart the host, then open or refresh the model list:

1. When enabled, the extension registers its provider. Registration and extension
   startup do not read credentials, make requests or open a page.
2. A model-catalog query reuses the saved GitHub credential, exchanges it for
   short-lived Copilot access and requests `/models` at the account's HTTPS API
   endpoint returned by GitHub. Valid saved access requires no browser page.
3. If credentials are absent or a remote request returns HTTP 401, the extension
   opens its local sign-in page and waits. Choose **Sign in with GitHub** there.
   The device code is not requested before that click. An invalid saved credential
   is retained until successful replacement; reauthorization does not require
   deleting it with Sign out first.
4. Successful sign-in automatically continues the original model query; no
   second refresh is required. Only models declaring `/chat/completions` or
   `/responses`, with complete positive token limits and no explicit streaming
   prohibition, are exposed as callable. Responses is preferred when both are
   declared. Tool, image and reasoning capabilities come from metadata, not
   model-name guesses. Other endpoints and incomplete metadata are excluded
   with diagnostics.
5. Cancel or closing the last local page returns an empty Copilot catalog instead
   of failing the aggregate model query. Automatic sign-in and catalog discovery
   remain paused for this provider instance: opening or refreshing the model list
   does not reopen the page. Restart my-agent, or disable and re-enable the
   extension, to clear this in-memory state. There is no TTL or persisted flag.
   Closing the page does not stop the host or account service, or sign out an
   existing account. Denial, expiry, network/policy errors and invalid metadata
   still fail explicitly rather than being presented as empty success.
6. Concurrent queries share one discovery/sign-in operation and one page launch.
   Cancelling one caller does not cancel the others; cancellation by all callers
   or host shutdown aborts the shared work. Waiting for sign-in is bounded to
   15 minutes. A subscription/policy error such as HTTP 403 fails without
   repeatedly opening sign-in.

The provider is displayed as **GitHub Copilot**, with the existing experimental
ID `copilot-login-experiment`. Select one of its listed models to chat. A configured
default reference has the usual host shape:

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "copilot-login-experiment",
      "modelId": "<an ID from this provider's current catalog>"
    }
  }
}
```

Do not copy the placeholder literally or assume every Copilot model is exposed.
Listing a model does not guarantee your subscription/organization permits
invocation; upstream rejection is surfaced, not bypassed.

### Native inference and reused protocol implementation

The host loads the provider's source entry through Jiti. The standalone build
emits the independent account launcher, not the host protocol modules; the
extension's separate type-check covers all source modules and tests.

- Chat Completions and Responses handle streaming text, complete/invalid Tool
  Calls, Tool Results, image blocks, token usage, terminal failures and reasoning
  replay using the existing Relay implementations, copied locally and adapted
  for the direct API. The original Relay extension has since been retired.
- The new wrapper owns credential loading, token exchange, the account endpoint,
  request cancellation, closed model membership and immutable per-Turn routing.
  Tokens are never placed in model messages or persisted in history.
- Calls exchange fresh short-lived access and send directly to the captured
  account endpoint; no Relay process is involved. An absent credential or HTTP
  401 can open sign-in before a request is accepted, with at most one retry.
  There is no automatic retry after output starts or for network/policy errors.
- A later catalog cannot reroute an existing binding. An account API endpoint
  change fails with a refresh/reselection instruction instead of moving a Turn.
- The direct Responses request uses `store: false`, requests encrypted reasoning
  for replay, and honors an explicit output limit. A model's maximum output
  capability is not silently made the request's default limit.
- Native adaptations retain bounded HTTP errors, add a one-MiB SSE event bound,
  and avoid reflecting raw upstream error messages into diagnostics. Public
  invocation identity and replay are owned by this provider, not the Relay ID.
- Closing the account page cancels pending sign-in, not an already authorized
  inference stream. Turn cancellation or host shutdown aborts inference through
  the ordinary invocation signal. Sign out removes the local credential, not an
  already accepted remote request or the GitHub OAuth grant.
- Dismissing sign-in does not turn an inference request into empty success.
  An unauthenticated bound invocation reports an authentication error without
  automatically reopening the dismissed page.

The prototype is source-workspace-only. It is not added to the root npm package
release files. It does not depend on the retired Relay extension or require
Copilot-specific changes to the WebSocket extension or host.

## Credential and lifecycle boundaries

- The extension owns device authorization, Copilot access verification,
  persistence, cancellation and status. The page displays only the public
  verification URL and temporary user-facing device code, never account tokens
  or GitHub's private polling device code.
- The page connects one authenticated SSE stream (`GET /api/events`) before
  enabling its control. Login, sign-out and cancel use HTTP POST. A saved
  sign-in is verified automatically when the first local page connects.
  Status and code changes are pushed over that stream; the browser does not poll
  for status.
  Closing the last stream immediately aborts unfinished sign-in or verification,
  including upstream requests. Late token results are checked for cancellation before
  verification or persistence. Web-mode authentication cannot start without a connected
  page. No heartbeat, unload beacon or WebSocket is required.
- Only a random-port `127.0.0.1` listener is used. Browser actions require a
  per-run capability key. Foreign Host and Origin values are rejected.
  No account credential appears in browser responses, command-line arguments or
  logs. Explicit terminal mode owns device authorization directly instead of
  using the web page/SSE connection.
- All platforms store a versioned JSON credential file under the current user's
  home directory:
  - Windows: `%USERPROFILE%\.my-agent\copilot-provider-login-spike\github-token.json`
  - macOS/Linux: `~/.my-agent/copilot-provider-login-spike/github-token.json`
  **The GitHub token is not encrypted at rest.** Keep this file private and out of
  source control, shared volumes and unprotected backups. POSIX directories use
  mode `0700` and files use `0600`; Windows inherits the user-profile filesystem
  ACLs (Node's POSIX mode does not enforce Windows ACLs).
  Saves use an exclusive temporary file followed by an atomic rename.
  This does not isolate credentials from other processes running as the same user.
  The short-lived Copilot token is used only in memory for verification or the
  current model-list/inference request, then discarded. Catalog responses are bounded to
  two MiB and invalid or duplicate model metadata fails explicitly.
- The previous Windows-only `github-token.dpapi` format is no longer read.
  Sign in once after upgrading. The old file is not automatically decrypted,
  copied or deleted; remove it yourself if no longer needed.
- The default directory does not read or modify `.llm-relay` or existing Relay
  state. There is one saved experiment account, not per-Agent account isolation.
  **Sign out** deletes only `github-token.json`, not its directory or other files,
  including a leftover legacy DPAPI file.
  Once requested, this local deletion can complete even if the page closes.
  A deletion failure is shown explicitly and is not reported as signed out.
- One operation runs at a time. Duplicate login returns an explicit conflict.
  Cancellation is unavailable during the final credential save or sign-out.
  A login attempt times out after 15 minutes or when GitHub's device code expires.
  Individual upstream calls time out after at most 15 seconds.
- Cancel stops local authorization polling; it does not revoke a GitHub grant
  already approved or delete an already saved credential. Closing the last
  local page cancels; closing GitHub alone cannot be detected. There is no
  reconnect grace period: a refresh which disconnects the last stream cancels
  that attempt rather than allowing unattended persistence. An atomic save
  already committed before cancellation is not rolled back.
  Shutdown aborts work and closes the local listener and SSE connections.
- Multiple simultaneous login/sign-out operations sharing the credential directory,
  remote browser access to the loopback account page, GitHub grant revocation and
  endpoints other than Chat Completions/Responses are outside the spike. For
  remote/headless hosts, use explicit terminal device-code login.

## Upstream limitations

The device flow and Copilot token exchange are adapted from `llm-relay` under
MIT; see `THIRD-PARTY-NOTICES`. The exchange uses
`api.github.com/copilot_internal/v2/token`, a fixed GitHub OAuth client ID and
the relay's existing editor/integration identity. This is **not** an official
Copilot SDK integration or a stability/support guarantee. Upstream changes,
plan restrictions and organization policies may reject it. Do not switch client
identities to circumvent policy. SDK/CLI credential compatibility is not tested.

## Validation and exit conditions

```powershell
npm run test --workspace @my-agent/copilot-provider
npm run lint --workspace @my-agent/copilot-provider
npm run build --workspace @my-agent/copilot-provider
```

Required observations:

| Scenario | Expected observation |
| --- | --- |
| Extension disabled through the host | Host skips loading the extension; no provider or authentication work |
| Enabled provider registration | Provider registered without credential reads, requests or page launch |
| Model query with saved access | Actual upstream catalog returned without opening a page |
| Model query without access | One sign-in page opens; success resumes the original query |
| Reauthorization | HTTP 401 permits fresh sign-in without deleting the old credential first |
| Concurrent model queries | One page/discovery operation; cancelling one caller preserves other callers |
| Sign-in dismissal during model discovery | Empty Copilot catalog; no repeat prompt until restart/re-enable; no late credential save |
| Caller cancellation during model discovery | Query rejects; caller cancellation does not mark sign-in as dismissed |
| Host shutdown during discovery | Upstream work and pending sign-in stop; no listener survives late startup |
| Successful authorization | Code and clickable link appear only after login; access verified before save; page updates without reload |
| Denial / missing subscription | Visible failure; no replacement credential |
| Cancel / expiry | Polling stops; old code/link disappear; retry requests a fresh code |
| Close local page | Last SSE disconnect aborts authorization; no new token is saved after cancellation |
| Restart | Saved credentials are checked automatically, not assumed valid |
| Sign out | Only the extension's credential file is removed; reopening stays signed out |
| File persistence | Versioned JSON survives restart; atomic replacement; POSIX owner-only permissions |
| Desktop portability | Windows/macOS/Linux launchers checked; failures report terminal login instructions |
| Headless authorization | Device code shown without browser/server; verify before save; cancellation preserves old access |
| Transport isolation | Foreign Origin/Host and missing keys rejected; account tokens absent from page |
| Native streaming | Both declared protocols deliver text, tools and usage; failures are explicit |
| Invocation authentication | HTTP 401 permits one sign-in/retry before output; no stream replay |
| Bound model routing | Refresh cannot change an existing protocol/facts binding; endpoint changes fail |
| Invocation cancellation | Caller cancellation and host shutdown abort pending stream reads |

Automated tests use synthetic upstream responses and exercise real local HTTP.
They do not authorize a GitHub account. A real browser/page smoke and
manual GitHub authorization are separate evidence. Passing mock authentication
does not complete the spike.

### Recorded results (2026-11-19)

- The previous CLI variant passed 14 extension tests plus 54 existing
  acquisition/discovery regression tests, extension type-check and build.
- The acquisition test uses the real descriptor, schema validation and Jiti
  loader, not just a direct factory import.
- The earlier Windows-only variant's DPAPI protection/decryption passed with a synthetic secret in a
  temporary directory, then that directory was removed.
- The previous variant's real Windows CLI/page smoke passed with simulated
  upstream GitHub/Copilot responses; that CLI path has now been removed.
- Single-button POST/SSE variant: 24 extension tests passed on Node.js 22.22.2,
  including code/link display, copy failure, cancel/expiry, SSE event shape,
  last-page disconnect, a token arriving after disconnection, automatic saved
  sign-in checking, sign-out success/failure, and exact-file credential deletion.
  The 54 existing acquisition/discovery regressions also passed (78 tests total). Extension
  type-check and build passed.
- Browser smoke with simulated upstream authorization confirmed in-page code
  and URL display, Cancel hiding the code, retry with a fresh code, and automatic
  cancellation after navigating away from the last local page. Returning showed
  cancellation with no saved credential. A subsequent simulated successful
  login pushed verified status and hid the instructions without status polling.
  The redesigned page also passed same-button Sign in / Cancel / Sign out
  transitions, automatic verification on reopening, and remaining signed out
  after reopening. At a 320-pixel viewport, content had no horizontal overflow.
- Temporary smoke servers were stopped. No real account was
  authorized and no real credential was written by these checks.
- Model-discovery integration: 43 extension tests plus 54 acquisition/discovery
  regressions passed (97 total). Extension type-check and build passed. Tests
  exercise actual provider registration and local HTTP/SSE with synthetic
  upstream authorization, saved-token reuse, HTTP 401 reauthorization, HTTP 403
  rejection, concurrent callers, page/button cancellation and shutdown during
  a delayed listener startup.
- Read-only live verification using the existing saved sign-in returned 56
  models. The active extension was also loaded through its real descriptor,
  schema and Jiti loader, and returned 56 models through the host's provider
  catalog boundary. These checks did not change saved credentials, perform new
  GitHub authorization or send inference requests.
- The owner confirmed manual host testing after the cancellation fix: dismissing
  sign-in no longer blocks the aggregate catalog or reopens sign-in on subsequent
  catalog reads. This confirmation does not establish acceptance of every live
  GitHub policy or operating-system case.
- Before protocol consolidation, the owner's selected `gpt-6.1-sol` passed one
  explicitly authorized real inference: the requested minimal reply was `OK`,
  with 11 input tokens, 5 output tokens and `end_turn`. This does not establish
  access to every listed model or confirm the final consolidation against the
  live service.
- Historical validation before Relay retirement: after adapting its protocol
  implementation, 67 new-extension tests,
  90 unchanged Relay client/provider tests and 54 acquisition/discovery tests
  passed together (211 total). Extension type-check and standalone build passed.
  The consolidation used synthetic inference streams; no additional real
  inference request was sent.
- Cross-platform filesystem/terminal revision: 135 tests passed together with
  acquisition/discovery regressions; type-check and standalone build passed.
  Windows ran real temporary-file persistence/replacement/deletion and a compiled
  headless-login smoke with synthetic GitHub responses (no real network or user
  credential changes). Windows/macOS/Linux launcher branches are mocked tests,
  not three-platform desktop acceptance. The POSIX permission test is skipped on
  Windows; native macOS/Linux permission/browser acceptance remains pending.

Stop and revisit the design if it requires changing existing host contracts,
reading another integration's credential store, running unapproved live model
probes, or bypassing organization policy.
