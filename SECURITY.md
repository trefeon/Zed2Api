# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Include the provider version, host and version (PI or OMP), a minimal
   reproduction, and the observed behavior.

Do not include account tokens, dashboard cookies, or complete request dumps.
If a credential may have been exposed, revoke it first and say that it was
revoked; do not paste the value.

## Credential handling

- Zed account credentials live in `~/.zed2api/accounts.json` with owner-only
  permissions.
- Dashboard cookies are optional and are read from `ZED_DASHBOARD_COOKIE` or a
  private file beside the account store.
- The provider does not log prompts, responses, tokens, or cookies.
- Reports that include secrets will be redacted before triage.
