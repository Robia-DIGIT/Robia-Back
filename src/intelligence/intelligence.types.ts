/**
 * RC-21 — Unified Intelligence Core.
 *
 * A single, additive contract every provider (current and future) speaks,
 * so `OpportunitiesService` and any future consumer (Command Center UI,
 * RC-22) can treat SEO/PageSpeed/Search Console/GA4/Meta/GBP uniformly
 * instead of hand-rolling provider-specific branches (the RC-19 `isMeta*`
 * family this RC replaces).
 *
 * Hard boundary, enforced by construction rather than by convention:
 * nothing in this module ever writes to `Audit.globalScore` or
 * `resultJson.seo_score_v2`, ever calls a second external API when data
 * already exists on the audit (PageSpeed), or ever fabricates a metric a
 * provider did not actually return (`data`/individual fields stay `null`
 * — never a synthetic `0`). See `docs/RC21_UNIFIED_INTELLIGENCE_CORE.md`
 * for the full architecture and threat model.
 */

/**
 * `'seo'` and `'ops'` are part of the contract (per the RC-21 issue) even
 * though no adapter for them ships in this RC: `'seo'`'s own adapter is
 * read-only introspection of the existing score (never a second SEO
 * engine), and `'ops'` is reserved for a future RC-20 Ops Automation
 * status bridge — registering it now costs nothing and avoids a breaking
 * type change later.
 */
export type IntelligenceProvider =
  'seo' | 'pagespeed' | 'search_console' | 'ga4' | 'meta' | 'gbp' | 'ops';

/**
 * `'ok'` — real, current data.
 * `'partial'` — real data, but incomplete (e.g. an audit predates seo_score_v2).
 * `'not_connected'` — no OAuth/connection exists at all for this org.
 * `'not_configured'` — connected, but a required selection (property/page) is missing.
 * `'unavailable'` — connected and configured, but the read itself failed or found nothing recent.
 */
export type ProviderStatus =
  'ok' | 'partial' | 'unavailable' | 'not_connected' | 'not_configured';

/**
 * A provider's current-state snapshot for one organization. Used by
 * `GET /intelligence/status` and by `IntelligenceRegistryService` — never
 * persisted as its own row (unlike `IntelligenceFinding`, which becomes an
 * `Opportunity`); it is always computed fresh from already-existing data.
 */
export interface IntelligenceSignal<T = unknown> {
  provider: IntelligenceProvider;
  status: ProviderStatus;
  organizationId: string;
  /** When the underlying data was last genuinely observed — never "now" unless the read itself is live and succeeded. */
  observedAt: Date | null;
  readOnly: boolean;
  scoreInfluence: boolean;
  /** `null` whenever status is not `'ok'`/`'partial'` — absence is never coerced into a zero-shaped object. */
  data: T | null;
  unavailableReason: string | null;
}

/**
 * A single explainable, provider-originated finding — the unit that
 * `OpportunitiesService` turns into an `Opportunity` row. Deliberately the
 * same shape family as the SEO engine's own findings (0-10 impact/effort
 * scale — see `python-service/app/agents/audit_rules.py`) so nothing
 * downstream (priority sorting, the top-5 cap) needs a provider-specific
 * branch.
 */
export interface IntelligenceFinding {
  provider: IntelligenceProvider;
  /** Stable across re-evaluations — the identity a re-run's dedup keys on, together with `provider`. */
  ruleCode: string;
  title: string;
  description: string;
  category: string;
  evidence: unknown[];
  recommendation: string | string[];
  impactScore: number;
  effortScore: number;
  confidenceScore: number;
  /** Always `false` for every provider shipped in RC-21 — nothing here feeds `seo_score_v2`. */
  scoreInfluence: boolean;
}

/**
 * The one piece of per-audit context a `collectFindings()` call may need.
 * Deliberately minimal and read-only: adapters that don't need audit
 * context (Meta today) simply ignore it.
 */
export interface AuditIntelligenceContext {
  auditId: string;
  /** `Audit.resultJson`, as already persisted — untrusted, raw JSON (same caveat as everywhere else this field is read). */
  auditResult: Record<string, unknown> | null;
}

/**
 * Implemented once per provider. `collectSignal` backs
 * `GET /intelligence/status` (an organization-level snapshot, not tied to
 * one audit). `collectFindings` backs opportunity generation for one
 * specific audit; a provider with no finding rules (PageSpeed, Search
 * Console, GA4, GBP in RC-21) simply returns `[]`.
 *
 * Every method must be safe to call speculatively: `IntelligenceRegistryService`
 * calls every adapter for every organization touching `/intelligence/status`
 * or opportunity generation, and a single provider's outage must never
 * prevent the others from being read (RC-21's "provider en panne" test
 * requirement) — an adapter that cannot avoid throwing is still isolated
 * by the registry's own `Promise.allSettled`, but should prefer resolving
 * to a `status: 'unavailable'` signal wherever the failure is expected
 * (not connected, no property selected, transient read failure).
 */
export interface IntelligenceProviderAdapter {
  readonly provider: IntelligenceProvider;
  readonly readOnly: boolean;
  readonly scoreInfluence: boolean;
  collectSignal(organizationId: string): Promise<IntelligenceSignal>;
  collectFindings(
    organizationId: string,
    context: AuditIntelligenceContext,
  ): Promise<IntelligenceFinding[]>;
}
