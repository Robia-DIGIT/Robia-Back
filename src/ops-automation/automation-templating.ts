/**
 * RC-20 — minimal, non-dynamic step-input templating.
 *
 * A step's `input` can reference the triggering event's payload with a
 * literal placeholder of the exact shape `"{{event.<key>}}"`. This is a
 * plain regex substitution against an already-fetched, organization-scoped
 * payload — never `eval`, never a general template language, never a path
 * that can reach anything beyond that one payload object. An automation
 * triggered manually or on a schedule has no source event, so any such
 * placeholder resolves to `null` — the action's own input validation then
 * rejects it as a missing value, rather than silently proceeding.
 */

const EVENT_PLACEHOLDER = /^\{\{event\.([a-zA-Z0-9_]+)\}\}$/;

export function resolveStepInput(
  input: Record<string, unknown> | undefined,
  eventPayload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!input) {
    return input;
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      const match = EVENT_PLACEHOLDER.exec(value);
      if (match) {
        resolved[key] = eventPayload?.[match[1]] ?? null;
        continue;
      }
    }
    resolved[key] = value;
  }
  return resolved;
}
