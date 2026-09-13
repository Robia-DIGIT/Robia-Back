# Observability (RC-15)

Status of what RC-15 ships, plus the alerting/sampling/retention
decisions that are **not** made here and need Romeo/Landry sign-off
before anything gets activated with a cost or a PII implication.

## What is implemented

- **Structured JSON logs** (NestJS via `nestjs-pino`, python-service via
  a stdlib `logging.Formatter`) — see `src/common/logging/logger.config.ts`
  and `python-service/app/logging_config.py`.
- **Request correlation**: a `requestId` is reused from an inbound
  `X-Request-Id` header when present, generated otherwise, and echoed
  back on the response and forwarded from NestJS to python-service on
  audit calls (`audits.controller.ts`).
- **Context enrichment**: `organizationId` and `userId` are attached to
  every log line once the request is authenticated/org-scoped
  (`logger.config.ts`'s `customProps`). `auditId` is attached once an
  audit is created or looked up (`audits.service.ts`, via
  `PinoLogger.assign()`), so every log line for the rest of that request
  carries it.
- **Redaction**, applied to every log line and to every outgoing Sentry
  event: key-based redaction of passwords/tokens/secrets/API
  keys/authorization/cookies/emails wherever they sit in the object graph,
  **plus** free-text scrubbing of the same categories of secret embedded
  inside an otherwise ordinary string (an exception message, a breadcrumb
  message) — see `src/common/logging/redact.ts`'s `scrubText` /
  `python-service/app/logging_config.py`'s `scrub_text`, and their specs
  for exactly what each catches. A key-based redactor alone was flagged
  as insufficient for Sentry in the Codex review that scoped this PR;
  this is the fix.
- **Sentry error capture**, optional and DSN-gated (`SENTRY_DSN` unset ⇒
  fully inert, same pattern as `GOOGLE_PAGESPEED_API_KEY` from RC-10).
  Every event goes through `sanitizeSentryEvent` / `sanitize_sentry_event`
  (`beforeSend`) before it leaves the process — the same redactor as
  above, so Sentry gets the identical guarantee application logs get, not
  a separate/weaker one.
- **Minimal external-call metrics** (duration, success/failure, provider),
  emitted as a structured `extra`/log field rather than to a dedicated
  metrics backend (none is wired up — see "Metrics backend" below):
  - `google_pagespeed_insights` — `python-service/app/integrations/pagespeed.py`
  - `site_crawl` — `python-service/app/agents/ingestion.py` (`crawl_website`)
  - `n8n` — `src/integrations/n8n-webhook.service.ts`

## What is explicitly NOT implemented, and why

- **No tracing / performance monitoring.** `tracesSampleRate: 0` /
  `traces_sample_rate=0` on both services — Sentry captures errors only.
  Turning tracing on is a paid-feature and PII-surface decision (request
  bodies/spans can carry more than an error event does) that this PR does
  not make. See "Sampling strategy" below.
- **No metrics backend** (Prometheus, Datadog, etc.). The three call
  sites above emit a structured log line with `metric: "external_call"` —
  a log-based-metrics pipeline (e.g. a Grafana Loki / Datadog log
  processor) can already build dashboards and alerts from this without
  further code changes. Standing up or paying for a dedicated metrics
  backend is a separate decision.
- **No alert delivery channel is wired up.** The definitions below are
  the *content* of the alerts this system can already produce signal
  for — none of them page or notify anyone yet. Wiring one (Sentry's own
  alerting, a Slack webhook, PagerDuty, ...) is a decision for
  Romeo/Landry, informed by whatever log/metrics pipeline they choose.

## Alert definitions (content only — no delivery channel wired up)

These are the minimal alerts the Codex review asked to have *defined*.
Each one names the signal already available today (from this PR) that
the alert would fire on, once a delivery channel exists.

| Domain | Condition | Signal already emitted |
|---|---|---|
| **Stripe** (billing) | A webhook signature verification fails, or a webhook handler throws | `src/billing/*` errors — currently reach Sentry as 5xx/unexpected exceptions via `AllExceptionsFilter`; a webhook-specific counter is not yet broken out separately |
| **Google** (PSI / GSC) | `external_call_metric` with `provider: "google_pagespeed_insights"` and `success: false` at a rate above a threshold (e.g. >50% of calls over 15 min) | Emitted per call in `pagespeed.py`; the GSC integration (`google-search-console.service.ts`) does not yet emit the same per-call metric — RC-13 scope, not RC-15 |
| **Crawl** | `external_call_metric` with `provider: "site_crawl"` and `success: false`, or `pagesFetched: 0` on a completed crawl | Emitted per call in `ingestion.py`'s `crawl_website` |
| **Deployment** | The `deploy` job in `.github/workflows/backend-ci.yml` fails, or the post-deploy `/health` check (see `DEPLOYMENT.md`) fails | GitHub Actions job status (already visible in the Actions UI) — no application-level signal needed |

Thresholds (the ">50% of calls", "15 min window" above) are illustrative,
not tuned — real thresholds need production traffic volume to set
sensibly and are a Romeo/Landry call once a delivery channel exists.

## Sampling strategy (current state, explicit)

- **Error events**: 100% — every unexpected/5xx exception is captured
  (see `AllExceptionsFilter`; 4xx `HttpException`s are never sent, they
  are expected client outcomes, not incidents).
- **Performance traces**: 0% (`tracesSampleRate` / `traces_sample_rate`
  hardcoded to `0` on both services). No transaction/span data is
  collected at all right now.
- **Logs**: no sampling — every request is logged (structured JSON to
  stdout), at `LOG_LEVEL` (default `info`). The one exclusion is the
  `/health` endpoint (`autoLogging.ignore` in `logger.config.ts`), which
  would otherwise dominate log volume without carrying useful signal.

Changing performance-trace sampling above 0% is a decision this PR
defers: Sentry's paid tiers price on trace volume, and traces can carry
more request detail (bodies, timing per internal call) than an error
event does, which is a wider PII surface than what RC-15 sanitizes today
end-to-end. If/when tracing is turned on, a rate (not 100%) and a review
of what a transaction payload contains should both happen at the same
time, not after the fact.

## Retention strategy (current state, explicit)

- **Application logs**: written to stdout only; retention is whatever
  the hosting/log-collection layer in front of the container keeps (not
  configured by this PR). No log retention policy is currently defined
  in this repository — this is a gap, not a decision, and needs
  Romeo/Landry input on the target retention window (cost vs.
  debuggability trade-off) once a log aggregation destination exists.
- **Sentry**: retention is whatever the configured Sentry
  plan/organization default is (not configured by this codebase; Sentry
  applies its own project-level retention, typically 90 days on paid
  plans). No `SENTRY_DSN` is set by default in any `.env.*.example`
  file, so no data is retained anywhere until one is deliberately
  configured for an environment.
- **Metrics-as-logs** (the `external_call_metric` lines): same retention
  as application logs above — no separate policy, since there is no
  separate storage for them yet.

## Decisions this PR does not make (for Romeo/Landry + Codex)

1. Whether/when to turn on Sentry performance tracing, and at what
   sample rate.
2. Which log aggregation / metrics backend (if any) to stand up, and the
   log retention window to configure there.
3. Which alert delivery channel(s) to wire the definitions above into,
   and the real thresholds for each.
4. Whether GSC calls (RC-13) should emit the same
   `external_call_metric` shape as PSI/crawl/n8n — not done here to keep
   this PR's scope to what the Codex review named for RC-15.
