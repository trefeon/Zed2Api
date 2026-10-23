# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
