# RC18 — Meta read-only integration

RC18 connects one Meta account per ROBIA organization and reads Facebook Page / linked Instagram professional account signals. It does not publish, edit, comment, reply, or modify external Meta assets.

## Security and product boundaries

- OAuth state is HMAC-signed, short-lived, and bound to the ROBIA organization owner.
- User and Page access tokens are AES-256-GCM encrypted before persistence.
- Tokens are never returned by API status/assets/performance endpoints.
- All authenticated endpoints use `JwtAuthGuard` + `OrgScopeGuard` and query by `organizationId`.
- The allowed OAuth scope list is restricted to read-oriented scopes in code.
- RC18 does not request `pages_manage_posts` or `instagram_content_publish`.
- Meta signals are outcome/social-presence evidence and do not feed `seo_score_v2`.

## Environment

Required variables:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_OAUTH_REDIRECT_URI=https://api.robiacopilot.site/integrations/meta/callback`
- `META_TOKEN_ENCRYPTION_KEY` — exactly 64 hexadecimal characters
- `META_OAUTH_STATE_SECRET` — exactly 64 hexadecimal characters

Configurable variables:

- `META_GRAPH_API_VERSION` — defaults to `v26.0`; keep this configurable when Meta versions change.
- `META_OAUTH_SCOPES` — comma-separated read-only scopes. Default: `pages_show_list,pages_read_engagement,instagram_basic`.
- `META_GRAPH_TIMEOUT_MS` — 1000–30000 ms, default 10000.

## Meta app configuration

Configure the exact OAuth redirect URI above in the Meta app. During development, Meta app roles/test users can be used before App Review. Production access for users outside the app roles may require Meta App Review / Advanced Access depending on the requested permissions and Meta policy at that time.

## API

- `GET /integrations/meta/authorize`
- `GET /integrations/meta/callback`
- `GET /integrations/meta/status`
- `GET /integrations/meta/assets`
- `POST /integrations/meta/assets/select` with `{ "pageId": "..." }`
- `GET /integrations/meta/performance`
- `DELETE /integrations/meta`

`performance` returns Facebook Page profile counts and, when a linked Instagram professional account is available, Instagram profile counts plus up to 10 recent media items. Missing external data remains missing; ROBIA does not invent Meta metrics.

## Future slices

RC18 intentionally excludes posting and autonomous actions. A later write-capable slice must go through RC14 human approval/evidence and request only the additional Meta permissions needed for the specific action.
