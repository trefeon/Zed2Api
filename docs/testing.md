# Testing

The test suite uses a mock upstream and a stubbed transport. No Zed account,
network access, or credential is required.

```sh
npm ci
npm run typecheck
bun run test
```

`bun run test` runs `tests/*.test.ts` explicitly. Do not run `bun test tests`
without the glob: that also matches reference checkouts and test files outside
this package.

## Mock upstream

`tests/mock-upstream.mjs` starts a local Zed-compatible HTTP server. Point the
provider at it with `ZED_API_BASE`:

```sh
bun tests/mock-upstream.mjs
# in another shell
ZED_API_BASE=http://127.0.0.1:8787 omp --extension . -p "/zed status"
```

The mock server exercises account lookup, `/client/llm_tokens`, `/models`, and
`/completions` without contacting Zed. The tests also cover SSE decoding,
tool-call translation, retries, usage accounting, and the event-loop exit
regression.

## Packaging check

```sh
npm run pack:check
```

The published tarball contains `index.ts`, `src/`, `README.md`, `LICENSE`, and
`package.json`. Tests and local development files are excluded.
