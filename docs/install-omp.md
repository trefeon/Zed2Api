# Install in OMP

## Requirements

- OMP `18.12.6` or newer.
- Node.js 20 or newer.
- A Zed account with hosted-model access.

## Install

From npm:

```sh
omp plugin install pi-zed-provider
```

From a source checkout:

```sh
git clone https://github.com/trefeon/Zed2Api.git
cd Zed2Api
omp plugin install .
```

OMP links a local directory into its plugin set, so keep the checkout in place.
Git sources are also accepted:

```sh
omp plugin install github:trefeon/Zed2Api
omp plugin install github:trefeon/Zed2Api#v0.2.0
```

A `.tgz` is not an installable source. Unpack it and install the directory
instead.

## Sign in

```sh
omp login zed
```

Or run `/login` inside OMP and choose Zed. The browser completes the native-app
handshake; the account is stored in `~/.zed2api/accounts.json`.

## Verify

```sh
omp plugin list
omp plugin doctor
omp models zed
```

Then run a real turn:

```sh
omp -p --model zed/gpt-5.6-luna "Reply with OK"
```

## Troubleshooting

- **Plugin missing**: `omp plugin doctor --fix` repairs a missing dependency or
  a stale runtime entry.
- **No `zed` models**: the plugin may be disabled, or `--no-extensions` may be
  in use. Check `omp plugin list` and run `omp plugin doctor`.
- **Version drift**: `omp plugin doctor --fix`, or reinstall with
  `omp plugin install pi-zed-provider --force`.
- **Login page does not redirect**: sign in to `zed.dev` in the same browser
  first. Do not probe the local callback port; a request without the callback
  parameters cancels the pending login.

## Update and remove

An npm install upgrades itself. At session start, in interactive sessions only,
the plugin asks the npm registry for the latest release (cached for six hours)
and runs:

```sh
omp plugin upgrade pi-zed-provider
```

The upgraded code loads on the next OMP start; nothing reloads in a running
process. `/zed update` forces a check now. A failed attempt is not retried for
24 hours, so run the command above by hand if the notice reports one.

A linked source checkout is not upgraded by the plugin: it is seen as a working
tree. Pull the checkout and reinstall:

```sh
git pull
omp plugin install . --force
```

Remove:

```sh
omp plugin uninstall pi-zed-provider
```

The account store is left untouched by uninstall.
