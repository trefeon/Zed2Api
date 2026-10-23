# Host-native login: PI and OMP

The provider is signed in through the host, not through a plugin-only slash
command.

```text
PI:  /login              # choose Zed, then name the account
OMP: omp login zed       # or /login inside the TUI
```

`/zed login [name]` remains available for adding or naming extra accounts.

## PI contract

PI `0.84.4` calls `oauth.login(callbacks)` from the interactive `/login` only;
there is no CLI login. The extension uses:

- `oauth.name` — display name in the login picker.
- `oauth.isSubscription` — marks subscription-backed access.
- `oauth.login` — opens Zed's browser handshake and prompts for the account
  name.
- `oauth.refreshToken(credentials, signal)` and
  `oauth.getApiKey(credentials)` — required whenever `oauth` is declared.

PI stores `{ type: "oauth", refresh, access, expires }` in
`~/.pi/agent/auth.json`, recomposes the provider, and refreshes availability.

`pi auth check --provider zed` does not load extensions in PI 0.84.4, so it is
not a readiness check. Use the model picker, `--list-models zed`, or a real
turn.

## OMP contract

`omp login [provider]` is the terminal counterpart of `/login`; with a provider
argument it invokes that provider's `oauth.login`. The credential is stored in
OMP's own auth store. `omp login zed` prompts for the account name, prints the
sign-in URL, and completes when the browser callback arrives.

## What the extension does

`oauth.login` runs Zed's `native_app_signin` handshake, stores the account in
`~/.zed2api/accounts.json`, resolves the organization, and caches the live model
catalog. The credential PI or OMP stores (`zed-account:<name>`) is a marker;
inference mints its own Zed JWT from the account store, so one sign-in serves
both hosts and extra accounts keep working.

## Tested hosts

| Host | Version |
| --- | --- |
| PI | `0.84.4` |
| OMP | `18.12.6` |
| Bun | `1.4.3` |
| Node | `24.22.0` |

Host contracts change between releases. If `/login` no longer lists Zed,
check the host's extension API version before changing the provider.
