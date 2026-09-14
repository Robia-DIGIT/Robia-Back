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
