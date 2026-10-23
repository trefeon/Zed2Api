# Install in PI

## Requirements

- PI `0.84.4` or newer.
- Node.js 20 or newer.
- A Zed account with hosted-model access.

## Install

From npm:

```sh
pi install npm:pi-zed-provider
```

Pin a version when you need reproducibility:

```sh
pi install npm:pi-zed-provider@0.1.0
```

From a source checkout:

```sh
git clone https://github.com/trefeon/Zed2Api.git
cd Zed2Api
pi install .
```

`pi install` writes user settings by default. Use `-l --approve` to record the
package in a project's `.pi/settings.json` instead.

## Sign in

Start PI and run:

```text
/login
```

Choose **Zed**, then name the account. PI opens the browser for Zed's
native-app sign-in. The account is stored in `~/.zed2api/accounts.json`; PI
stores only an OAuth marker in its own auth file.

## Verify

```sh
pi --list-models zed
```

The model picker should list the account's models. A real turn is the final
check:

```sh
pi -p --model zed/gpt-5.6-luna "Reply with OK"
```

`pi auth check --provider zed` does not load extension providers in PI 0.84.4,
so it can report `provider_not_found` after a successful login. Use the model
picker, `--list-models`, or a turn instead.

## Troubleshooting

- **No `zed` models**: confirm the extension is enabled, run `pi list`, and
  restart PI. Extension load errors are shown in interactive mode, not in
  `--list-models` output.
- **Login opens a page that never redirects**: sign in to `zed.dev` in the same
  browser first, then reopen the login URL. Do not probe the local callback
  port; a request without the callback parameters cancels the pending login.
- **No default model after install**: select a `zed/...` model in the picker.

## Update and remove

```sh
pi update --extensions
pi remove npm:pi-zed-provider
```

For a source install, pass the same path you installed:

```sh
pi remove .
```
