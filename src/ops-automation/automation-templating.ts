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
 *
 * RC-26: a step's input can itself contain a plain object value (e.g.
 * robia.notification.send_email's `templateData`, an
 * OpsActionsRegistryService objectInputFields field) — one level of that
 * object's own values is resolved the same way, so
 * `{ templateData: { websiteUrl: "{{event.websiteUrl}}" } }` works exactly
 * like a top-level placeholder. Deliberately bounded to one extra level,
 * not full recursion: still "minimal, non-dynamic", never a general tree
 * walker over arbitrary caller-supplied shapes.
 */

const EVENT_PLACEHOLDER = /^\{\{event\.([a-zA-Z0-9_]+)\}\}$/;

function resolveValue(
  value: unknown,
  eventPayload: Record<string, unknown> | null | undefined,
  allowNestedObject: boolean,
): unknown {
  if (typeof value === 'string') {
    const match = EVENT_PLACEHOLDER.exec(value);
    return match ? (eventPayload?.[match[1]] ?? null) : value;
  }
  if (
    allowNestedObject &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const resolved: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      // false: exactly one level of nesting, never deeper.
      resolved[key] = resolveValue(nested, eventPayload, false);
    }
    return resolved;
  }
  return value;
}

export function resolveStepInput(
  input: Record<string, unknown> | undefined,
  eventPayload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!input) {
    return input;
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    resolved[key] = resolveValue(value, eventPayload, true);
  }
  return resolved;
}
