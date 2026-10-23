# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
