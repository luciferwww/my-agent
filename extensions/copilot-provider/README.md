# Copilot Provider

Copilot Provider is an **LLM provider extension for my-agent**. It makes models
available to your GitHub Copilot account discoverable and callable through
my-agent's provider interface, so you can select them for conversations and
tool calls.

As an LLM provider, the extension owns GitHub sign-in, model discovery and authenticated model
requests. **my-agent still owns the Agent loop, sessions and context management.**
Requests go directly to Copilot; no Copilot CLI, SDK or Relay process is required.

**Status: Experimental, source-workspace-only.** This private extension is not
included in the root npm release. It uses unofficial Copilot interfaces, not an
official SDK integration or support contract. Model availability depends on your
subscription and organization policies; a listed model is not a guarantee that
your account can invoke it.

## Quick start

Requires Node.js 22 and a source checkout of my-agent. Run these commands from
the **repository root**, the directory containing the root `package.json`:

```powershell
npm run agent
```

1. Start my-agent normally with the command above. The host loads the enabled
   Copilot extension itself; **no separate Copilot launcher is required**.
2. Open the model list. If no valid saved access is available, the extension
   opens its local sign-in page. Choose **Sign in with GitHub**.
3. Select **Copy code**, open the displayed GitHub URL and enter the code
   **on GitHub**. Approve access with the intended account.
4. Wait for the local page to confirm access. The extension verifies Copilot
   access before saving the credential, then resumes the model query.
5. Open the model list and select a model under **GitHub Copilot**.

If the extension was disabled, enable it as described below and restart the
host. Sign-in can also open on demand during an invocation. There is no
Copilot-specific login button in WebSocket Settings. Independent account
management is an optional auxiliary tool described below, not the LLM provider's
startup command.

## Host configuration and model selection

The extension is enabled by default when acquired from the source workspace.
To enable it explicitly, merge this into your Agent Home configuration:

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

Set `enabled` to `false` to prevent loading, then restart the host. There are no
extension-specific `active`, `baseURL`, `apiKey` or discovery-TTL options; remove
the obsolete `config.active` field if present.

The displayed provider name is **GitHub Copilot**. Its current experimental
provider ID is `copilot-login-experiment`, distinct from the extension ID
`copilot-provider`. To configure a default model:

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

Replace the placeholder with a discovered model ID. Discovery exposes only
models with supported streaming endpoints and valid token-limit metadata.
Tool, image and reasoning support comes from that metadata, not model-name
guesses. The provider supports Chat Completions and Responses, preferring
Responses when both are declared.

For general configuration and protocol boundaries, see the
[configuration guide](../../docs/guides/configuration.md#72-copilot-provider-source-workspace-experiment)
and [Provider architecture](../../docs/architecture/providers.md#7-copilot-external-unit).

## Account management

### Optional standalone account management (desktop)

Use these commands only when you want to sign in before starting my-agent, or
explicitly sign out:

```powershell
npm run build --workspace @my-agent/copilot-provider
npm run start --workspace @my-agent/copilot-provider
```

**The start command runs only a local account-management service and opens its
page. It does not start my-agent, run conversations or act as a model proxy.**
The host does not depend on this service being started separately or kept
running. Rebuild the launcher after source changes. Stop my-agent before using
the standalone launcher, and stop the launcher with Ctrl+C before starting
my-agent again; simultaneous account services sharing the credential file are
unsupported.

Windows, macOS and
Linux use the default browser through `rundll32.exe`, `open` and `xdg-open`
respectively. Linux desktop mode usually requires `xdg-utils`.

The local page has one main button:

| Account state | Action |
| --- | --- |
| Not connected or reauthorization required | **Sign in with GitHub** |
| Signing in or checking saved access | **Cancel** |
| Connected or saved access needs attention | **Sign out** |
| Saving or signing out | Disabled progress indicator |

Opening the page automatically checks saved access. With no saved credential,
it requests a device code only after you choose to sign in. The GitHub URL is
opened by you, not automatically; clipboard failure prompts manual copying.

Keep the launching terminal running while using the page. Closing the last
local page cancels unfinished sign-in or verification, but leaves the server
running and does not sign out. Reopen the private URL printed in the terminal
to return. A reload can cancel an attempt when the last page connection closes;
sign in again if needed. If the page-access key is lost, use the original URL.
Stop the launcher with Ctrl+C before starting another instance.

**Sign out** removes the extension's saved local credential. It does not revoke
the GitHub OAuth grant, sign out of GitHub, or cancel an already accepted remote
inference request.

### Headless Linux, Docker and SSH

Build the launcher, then run on the host or container where my-agent will run,
as the same operating-system user:

```sh
npm run start --workspace @my-agent/copilot-provider -- --device-code
```

This explicit terminal mode prints a verification URL and user-facing device
code, without opening a browser or starting a local server. Open the URL on
another device and enter the code. The command verifies access, saves the
credential on the original host and exits. Ctrl+C cancels without replacing an
existing credential. Account tokens are never printed.

Then start my-agent or retry the failed model query. Browser mode does not
automatically fall back to terminal mode; browser-launch failures report this
command. Remote access to the loopback account page is unsupported.

In containers, persist the credential directory with a private volume and keep
the same user/home directory across restarts. Do not bake credentials into images
or share the volume with untrusted users.

## Authentication behavior and troubleshooting

Registration is inert: it does not read credentials, make requests or launch a
page. A model-catalog query, including an automatic startup query, can initiate
sign-in when saved access is unavailable.

| Situation | Behavior / next step |
| --- | --- |
| Valid saved access | Discovery and inference use it without opening a page. |
| No credential or HTTP 401 | Sign-in can open; successful authorization resumes the request. An invalid old credential is retained until successful replacement. |
| Cancel or close sign-in during discovery | Returns an empty Copilot catalog and pauses automatic sign-in/discovery for that provider instance. Restart my-agent or disable and re-enable the extension to reset the pause. Refreshing the model list alone does not reset it. |
| Invocation after dismissed sign-in | Reports an authentication error; it does not return empty success or automatically reopen the dismissed page. |
| HTTP 403, policy rejection or network failure | Fails explicitly without repeated sign-in prompts. Check account access, organization policy or connectivity. |
| Concurrent catalog requests | Share one discovery/sign-in operation. Cancelling one caller preserves other callers; cancelling all callers or shutting down the host aborts shared work. |
| Account API endpoint changes | Existing model bindings fail with a refresh/reselection instruction instead of silently rerouting a Turn. |

Authorization is bounded to 15 minutes or device-code expiry. Individual
upstream calls have a maximum 15-second timeout. Invocation permits at most one
sign-in/retry after HTTP 401 before output begins; there is no automatic stream
replay or retry for network/policy failures. Turn cancellation or host shutdown
aborts inference; closing an account page cancels pending sign-in, not an already
authorized stream.

Denied, expired or failed authorization never replaces an existing credential.
A successful access check does not guarantee every model works. SDK/CLI
credential compatibility is not tested, and the extension does not read their
credential stores.

## Credential storage and security

The extension stores one account per operating-system user, not per Agent Home:

| Platform | Credential file |
| --- | --- |
| Windows | `%USERPROFILE%\.my-agent\copilot-provider\github-token.json` |
| macOS / Linux | `~/.my-agent/copilot-provider/github-token.json` |

**The saved GitHub token is plaintext, not encrypted at rest.** Keep it out of
source control, shared volumes and unprotected backups. POSIX directories use
`0700` and files use `0600`; Windows inherits user-profile filesystem ACLs.
This does not protect against other processes running as the same user.

Credential saves use an exclusive temporary file and atomic replacement.
If the new credential file is absent, the default store validates and migrates
`github-token.json` from the old `copilot-provider-login-spike` directory. The old
file is removed only after the new copy is saved successfully. An existing new
credential takes precedence; invalid old credentials fail explicitly.
Sign out deletes `github-token.json` from both locations to prevent an old login
from returning, not the directories or unrelated files.
Deletion failures are reported explicitly. The legacy `github-token.dpapi`
format is not read, migrated or automatically deleted; sign in again and remove
the old file yourself if no longer needed. Existing Relay state is not accessed.

The account server listens only on a random-port `127.0.0.1` address. Browser
actions require a per-run capability key, and foreign Host/Origin values are
rejected. The page uses an authenticated SSE connection for status updates and
POST requests for actions. It exposes only the public verification URL and
temporary user-facing code, never account tokens or the private polling code.
Short-lived Copilot access tokens stay in memory and are not placed in model
messages, history or logs. Treat the launcher's private page URL as sensitive.

The token exchange uses `api.github.com/copilot_internal/v2/token` and a fixed
OAuth client/editor identity adapted from `llm-relay`. Upstream changes may break
this integration. Do not change identities to circumvent organization policy.
See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES) for attribution.

## Development and validation

```powershell
npm run test --workspace @my-agent/copilot-provider
npm run lint --workspace @my-agent/copilot-provider
npm run build --workspace @my-agent/copilot-provider
```

The host loads the source entry through Jiti. The standalone build produces the
account launcher; the separate type-check covers protocol modules and tests too.
Protocol implementations are local adaptations of the retired Relay, with no
cross-extension private imports.

Automated tests use synthetic upstream responses and real local HTTP; they do
not authorize a GitHub account. They cover account transitions and cancellation,
credential persistence, model discovery, concurrent callers, immutable model
bindings, native streaming and shutdown.

Real GitHub authorization and live inference require separate explicit approval.
Mock tests do not establish upstream policy compatibility or full cross-platform
acceptance. Native macOS/Linux permissions and desktop-browser acceptance remain
pending; their launcher branches are tested with mocks.
