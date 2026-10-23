# Usage and spend

There are two meters, and they answer different questions.

| Meter | Covers | Source |
| --- | --- | --- |
| Local ledger | Turns served by this provider, on this machine | `~/.zed2api/usage.jsonl` |
| Dashboard | Every Zed-hosted token on the account, including the editor and Delta | `dashboard.zed.dev` → Billing → Usage |

`/zed usage` prints the local ledger and, when a dashboard session cookie is
configured, the dashboard's own summary beside it.

```text
/zed usage            # local calendar month
/zed usage --all      # every recorded turn
/zed usage --json     # machine-readable snapshot
```

## Local ledger

Every completed turn appends one JSON line:

```json
{"ts":1792745000000,"account":"default","userId":"123456","organizationId":"org_test","model":"gpt-5.6-luna","input":1234,"output":567,"cacheRead":0,"cacheWrite":0,"costUsd":0.001022}
```

- No prompt or response text is stored.
- The file sits beside `accounts.json`; `ZED_USAGE_FILE` overrides the path.
- Deleting the file resets local history. Dashboard history is unaffected.
- Costs use Zed's published hosted-model prices (API list price +10%), taken
  from `zed.dev/docs/account/zed-hosted-models` on 2026-10-23. A model that is
  absent from that page uses the provider's list price +10% (Claude Haiku 5.5,
  Gemini 4 Argon, Gemini 3.8 Flash, Gemini 2.5 Pro, Grok 4). Tiers switch on
  prompt length or date are not modeled; the base tier is used. Models without
  any researched rate still count tokens but are excluded from the dollar
  total.
- The local window is the calendar month. Zed's billing month resets on the
  subscription's billing date, so the two windows can differ by a few days.

### Cache accounting

| Dialect | Fields read | Cost treatment |
| --- | --- | --- |
| OpenAI Responses | `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens` | Both are subsets of `input_tokens`; uncached input is the difference, cache reads/writes use their table rates |
| Anthropic Messages | `cache_read_input_tokens`, `cache_creation_input_tokens` (from `message_start` and `message_delta`) | `input_tokens` already excludes them; each is billed at its own rate |
| xAI Chat Completions | `prompt_tokens_details.cached_tokens` | Cached tokens are a subset of `prompt_tokens`; uncached input is the difference |
| Gemini | `cachedContentTokenCount` | Zed bills no separate cached-input price, so the whole prompt is input |

A cache read is about 10× cheaper than input; a cache write is about 25% more
expensive. The first request for a new prompt prefix writes the cache, and an
identical follow-up reads it. If the host changes the prompt prefix every turn,
every turn pays the write. `Cache R / W` in `/zed usage` shows the split.

## Plan credit

| Plan | Included token credit |
| --- | --- |
| Pro / Pro trial | $5.00/month |
| Student | $10.00/month |
| Business | none bundled |
| Free | none |

The dashboard's `plan` field wins. Without a dashboard cookie, set
`ZED_PLAN=student` (or `pro`, `business`, `free`) or write the plan name to
`~/.zed2api/plan`. The monthly spend limit (default $10 on Pro) is separate
from the included credit.

## Exact dashboard usage

The dashboard API is `https://cloud.zed.dev/frontend/billing/usage`. It is
authenticated with the dashboard's web session cookie; the native app
credential is rejected with HTTP 401, so it cannot be called from the account
token alone.

1. Open <https://dashboard.zed.dev> while signed in and select the organization.
2. Open DevTools → Network, reload the Billing → Usage page, and find the
   request to `cloud.zed.dev/frontend/billing/usage`.
3. Copy its request `Cookie` header.
4. Make it available to the plugin, either for the current shell:

   ```powershell
   $env:ZED_DASHBOARD_COOKIE = 'session=…; other=…'
   ```

   or in a private file beside the account store:

   ```powershell
   Set-Content -NoNewline "$HOME\.zed2api\dashboard-cookie" 'session=…; other=…'
   ```

The cookie is a credential: do not paste it into a repository, issue, or log.
The plugin sends it only to `cloud.zed.dev/frontend/billing/usage` and never
prints it. It expires when the dashboard session expires; refresh it the same
way. When the request fails, `/zed usage` keeps the local report and prints the
reason instead.

The response carries `plan`, `current_usage.token_spend.spend_in_cents`,
`limit_in_cents`, `updated_at`, and `portal_url`. The credit line follows
`plan` (Pro $5.00, Student $10.00, Business none); usage beyond the credit
bills at list price +10%, and the default monthly spend limit is $10. Set the
limit to $0 to cap token spend at the included credit.

## Edit predictions

Edit Prediction is a **Zed editor** feature (the Zeta model), not a chat model.
This provider does not serve it, and PI/OMP have no inline prediction surface,
so the unlimited Student quota cannot be spent through `/completions`.

To use it:

1. Open the Zed editor and sign in with the same account.
2. Keep `"edit_predictions": { "provider": "zed" }` in settings (the default
   when signed in); the Z icon in the status bar shows Zeta is active.
3. Type code and accept a prediction with `tab`, `alt-l` (Windows/Linux), or
   `alt-tab`. The dashboard counter increments on accepted predictions.

When a dashboard cookie is configured, `/zed usage` also prints the dashboard's
`edit_predictions` counter, e.g. `0 used of unlimited`.

## Update checks

The plugin keeps itself current; this section only covers the commands and what
they report.

```text
/zed update           # check npm now, bypassing the six-hour cache
/zed status           # show a cached "x.y.z is available" line, no network
```

A session start performs the same check in the background, but only when the
host has an interactive UI. Print and subagent runs never upgrade.
`ZED2API_SKIP_UPDATE_CHECK=1` disables the check for both paths. Upgraded code
stays inactive until the host restarts.

## Notes

- Local metering starts when this version records its first turn; earlier turns
  are not backfilled.
- The dashboard figure is the authority for billing. The local figure is the
  best a host can compute for the calls it made.
- Edit predictions and other Zed clients are outside the local ledger.
