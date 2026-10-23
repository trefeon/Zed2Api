# pi-zed-provider

Use a **Zed subscription** as a native model provider in
[PI](https://github.com/earendil-works/pi) and
[OMP](https://github.com/can1357/oh-my-pi).

The extension registers a `zed` provider whose model catalog comes from the
connected Zed account. Account storage, sign-in, token refresh, model catalog,
request conversion, streaming, tool calls, and usage accounting all run inside
the extension; no gateway process is involved.

Requires a Zed account with hosted-model access (Pro, Student, or Business).
Not affiliated with Zed Industries.

## Install

From npm, one command per host:

```sh
omp plugin install pi-zed-provider
pi install npm:pi-zed-provider
```

From a source checkout:

```sh
git clone https://github.com/trefeon/Zed2Api.git
cd Zed2Api
omp plugin install .
pi install .
```

For a single run without changing host configuration:

```sh
omp --extension .
pi --extension .
```

Both hosts read the entry point from `package.json` (`pi.extensions` and
`omp.extensions`). A `.tgz` is not an installable source on either host;
install the package or the directory instead.

## Sign in

```sh
pi  # then run /login, choose Zed, and name the account
omp login zed
```

`/zed login [name]` is also available for adding or naming extra accounts.
The browser completes Zed's native-app sign-in and the callback writes the
account to `~/.zed2api/accounts.json` with owner-only permissions.

## Commands

| Command | Effect |
| --- | --- |
| `/zed` or `/zed status` | Accounts, active account, cooldowns, last HTTP status |
| `/zed login [name]` | Add an account through the browser flow |
| `/zed accounts` | List stored accounts |
| `/zed switch <name>` | Make an account active |
| `/zed forget <name>` | Remove an account |
| `/zed models` / `/zed refresh` | Print or refresh the live model catalog |
| `/zed probe [name]` | Send a 32-token completion per account and report state |
| `/zed usage [--json] [--all]` | Local token spend; exact plan usage when a dashboard cookie is configured |

## Models

The provider advertises every model the account can serve. The request dialect
is selected from the model id:

| Family | Id prefix | Wire dialect | Reasoning |
| --- | --- | --- | --- |
| Anthropic | `claude*` and unknown ids | Messages | `low` … `max` via `output_config.effort` |
| OpenAI | `gpt*` | Responses | `low`, `medium`, `high`, `xhigh` |
| Google | `gemini*` | Gemini `contents` / `systemInstruction` / `functionDeclarations` | forwarded as supported |
| xAI | `grok*` | Chat Completions | forwarded as supported |

The model list is live: a successful sign-in, `/zed refresh`, or a host-side
refresh updates the cache in `~/.zed2api/model-catalog.json`. OMP merges
discovered models into its catalog; PI seeds its startup registration from the
cache so later processes see the full list.

Window and output limits come from the highest specification declared for the
same model in the built-in provider catalog, not from a family-wide ceiling.
Current examples: GPT-5.6 and GPT-6 advertise 1,050,000 context and 128,000
output tokens; Claude Sonnet 5 and Haiku 5 advertise 1,000,000 and 128,000;
Gemini advertises 1,048,576 and 65,536. New ids that are not in the static map
fall back to the family's highest specification. `ZED2API_CONTEXT_WINDOW` and
the per-family output overrides still win.

## Usage

`/zed usage` reports the turns this provider served, using Zed's published
hosted-model rates. A dashboard cookie adds the account-wide figures from
`dashboard.zed.dev`, including the editor and other clients.

```sh
/zed usage
/zed usage --json
/zed usage --all
```

The local ledger is `~/.zed2api/usage.jsonl`; no prompt or response text is
stored. The dashboard is authoritative for billing. See
[docs/usage.md](docs/usage.md) for cache accounting, plan credit, and how to
supply the dashboard cookie.

## Configuration

All settings are optional. Credentials live outside the repository.

| Variable | Purpose |
| --- | --- |
| `ZED_ACCOUNTS_FILE` | Account-store path (default `~/.zed2api/accounts.json`) |
| `ZED_USAGE_FILE` | Local usage ledger path |
| `ZED_PLAN` | `pro`, `student`, `business`, or `free` when no dashboard cookie is set |
| `ZED_DASHBOARD_COOKIE` | `Cookie` header for `dashboard.zed.dev` usage |
| `ZED_API_BASE` | Upstream base URL; used by the mock upstream in tests |
| `ZED2API_CONTEXT_WINDOW` | Override the advertised context window |
| `ZED2API_CLAUDE_MAX_TOKENS` | Override the Anthropic output cap |
| `ZED2API_GPT_MAX_TOKENS` | Override the OpenAI output cap |
| `ZED2API_CLIENT_VERSION` | Override the Zed client version sent upstream |
| `ZED2API_SYSTEM_ID` | Override the per-install system id |

## Development

```sh
npm ci
npm run typecheck
bun run test
npm run pack:check
```

The tests use a mock upstream and stub transport; no Zed account or network is
required. See [docs/testing.md](docs/testing.md) for the test harness.

Host-specific install and login details:
[docs/install-pi.md](docs/install-pi.md),
[docs/install-omp.md](docs/install-omp.md), and
[docs/host-login.md](docs/host-login.md).

## Security

Account credentials and usage data stay on the local machine. The provider does
not log prompts, responses, or tokens. Do not paste `accounts.json`, dashboard
cookies, or full request dumps into an issue. Report vulnerabilities through
GitHub Security Advisories as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
