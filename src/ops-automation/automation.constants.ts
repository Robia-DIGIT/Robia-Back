// RC-20 guardrails. Every one of these exists to bound what an Automation
// can do, independent of what a caller asks for — see
// docs/RC20_OPS_AUTOMATION_CORE.md ("Garde-fous").

/** A single automation definition cannot have more steps than this. */
export const MAX_STEPS_PER_AUTOMATION = 20;

/**
 * How many "hops" a run is allowed to have been triggered through
 * (run A's execution triggers run B, which triggers run C, ...). Nothing in
 * RC-20's action registry can actually trigger another automation yet — no
 * action emits an event — so this is always 0 today. It exists so that once
 * an action *can* emit an event (a later RC), a runaway trigger loop is
 * rejected instead of silently recursing.
 */
export const MAX_TRIGGER_DEPTH = 3;

// RC-25 hardening guardrails — AutomationSchedulerService's own tick.

/**
 * How many due automations AutomationSchedulerService will process
 * concurrently within a single tick. Bounds worst-case load on the DB and
 * on whatever an ops action's step actually does (real I/O), independent of
 * how many automations happen to be due at once — never unbounded
 * `Promise.allSettled` over the whole due-set.
 */
export const SCHEDULER_MAX_CONCURRENCY = 5;

/**
 * How many due automations a single tick will attempt at most, however
 * large the due-set has grown. Anything beyond this is simply left for the
 * next tick (a minute later) — its own nextRunAt is never touched, so
 * nothing is lost, only delayed, exactly like a claim that lost the race or
 * a lease that hasn't gone stale yet.
 */
export const SCHEDULER_MAX_BATCH_SIZE = 50;

// RC-29 — "activating" the PROGRAM/COHORT scopes RC-20 reserved
// (docs/RC20_OPS_AUTOMATION_CORE.md's "Séparation des scopes (préparée, non
// construite)") means exactly this: `Automation.scope` becomes a settable,
// validated field instead of a column nothing ever writes to explicitly.
// Nothing here filters or branches on `scope` — that stays true after this
// change too — so an ODC automation using `PROGRAM` is a plain
// categorization value, never a second isolation dimension layered on top
// of `organizationId`, which alone remains the only enforced boundary.
export const AUTOMATION_SCOPES = [
  'ORGANIZATION',
  'ROBIA_INTERNAL',
  'PROGRAM',
  'COHORT',
] as const;
export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];
