# Contributing

Issues and pull requests are welcome. Please keep changes focused and include a
test for behavior that can regress.

## Setup

Requirements: Node.js 20 or newer, npm, and Bun 1.4.3 for the test runner.

```sh
npm ci
npm run typecheck
bun run test
```

The tests use a mock upstream and do not need a Zed account or network access.
See [docs/testing.md](docs/testing.md).

## Pull requests

- Keep the change scoped to one behavior or one bug.
- Run `npm run typecheck`, `bun run test`, and `npm run pack:check` before
  opening the pull request.
- Do not commit account files, dashboard cookies, request dumps, or any other
  credential. Redact tokens and account ids from logs in issues and pull
  requests.
- Model ids and wire behavior should follow the upstream catalog and protocol;
  include the observed request/response shape when changing a dialect.

## Commit messages

Use a short imperative subject, for example:

```text
fix: recover the final text from a stream-ended event
docs: document the dashboard usage cookie
```

## Security

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
