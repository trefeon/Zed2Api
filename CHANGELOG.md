# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-24

### Added

- Self-update at session start. When a session begins on a host with a UI, the
  extension asks the npm registry whether a newer release exists (4-second
  timeout, answer cached for 6 hours in `~/.zed2api/update-check.json` beside
  the account store) and installs it with the host's own package manager:
  `omp plugin upgrade pi-zed-provider` for OMP, `pi update npm:pi-zed-provider`
  for PI. The version is re-read from the installed `package.json` after the
  command; the exit code alone is not proof of an upgrade.
- `/zed update` runs the check immediately, ignoring the cached answer, and
  reports the outcome. `/zed status` adds the cached "`x.y.z` is available"
  line without touching the network.
- `ZED2API_SKIP_UPDATE_CHECK=1` disables the updater entirely.
- Print and subagent runs never start an upgrade, because they have no notice
  path. Only an applied upgrade or a failure is reported; an install that is
  already current stays silent.
- A failed attempt is remembered for 24 hours, and `update.lock` (stale after
  10 minutes) keeps two sessions from upgrading at the same time.
- A source checkout is never pulled. The updater reports it as unmanaged and
  leaves `git pull` to the operator.

## [0.1.3] - 2026-10-23

### Changed

- Upstream requests now carry Zed's real global
  `User-Agent: Zed/<version> (<OS>; <ARCH>)`, using the same auto-refreshed
  release version as `x-zed-version`.
- The HTTPS edge is reached over HTTP/2 with hyper-compatible SETTINGS
  (2 MiB stream window, 5 MiB connection window, 16 KiB frames/header list),
  rustls-compatible TLS cipher/group/signature preferences including the
  X25519MLKEM768 hybrid group, request header ordering, and reqwest's
  15-second PING / 10-second timeout keepalive.
- Sessions are pooled per origin and closed after 30 seconds idle.
  `ZED2API_HTTP1=1` remains as a debugging escape hatch.

## [0.1.2] - 2026-10-23

### Fixed

- Added the missing local price rows for Claude Haiku 5.5, Gemini 4 Argon,
  Gemini 3.8 Flash, Gemini 2.5 Pro, and Grok 4. Rates use the provider list
  price +10% where Zed's hosted-model page does not list the model; base tiers
  only.
- The model-catalog cache now stays beside the account store that owns it,
  instead of always using the default home directory. A test or a custom store
  can no longer overwrite `~/.zed2api/model-catalog.json`.

## [0.1.1] - 2026-10-23

### Fixed

- Model catalog limits now use the highest specification declared for the same
  model in the built-in provider catalog instead of conservative family-wide
  ceilings. GPT-5.6 and GPT-6 advertise 1,050,000 context and 128,000 output
  tokens; Claude Sonnet 5 and Haiku 5 advertise 1,000,000 and 128,000; Gemini
  advertises 1,048,576 and 65,536. Older and unknown ids keep their own cap or
  the family fallback.

## [0.1.0] - 2026-10-23

### Added

- Native `zed` provider for PI and OMP, with no gateway process.
- Host-native login through PI `/login` and `omp login zed`.
- Live model catalog from the connected Zed account, cached for later
  processes.
- Anthropic Messages, OpenAI Responses, Gemini, and xAI Chat Completions
  dialects.
- Multi-account storage, switching, rotation, and cooldown handling.
- Streaming text, reasoning, tool calls, and usage accounting.
- `/zed` commands for accounts, models, probes, and local spend.
- Optional dashboard usage and plan-credit reporting with a session cookie.
- Tests against a mock upstream covering transport, decoding, request
  conversion, usage, and process exit.

### Security

- Account credentials and usage data stay on the local machine.
- The provider does not log prompts, responses, tokens, or cookies.
