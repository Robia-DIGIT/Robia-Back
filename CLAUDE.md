# Working conventions for Claude on this repository

## Branch per RC

Each RC (release chunk) developed by Claude gets its own branch, created fresh
from the current `main`:

```
rcNN/claude
```

Examples already used: `rc19/claude`, `rc20/claude`, `rc21/claude`.

Rules:

- Always branch from the tip of `origin/main` at the time the RC starts —
  never from another RC's branch, and never from a stale/cached checkout.
- One branch per RC. Do not reuse a previous `rcNN/claude` branch for a new,
  unrelated RC.
- If a session's default/platform-assigned branch differs from this
  convention (for example a generic `claude/<session-slug>` branch) and
  already carries unrelated history, do not build the RC on top of it —
  create the proper `rcNN/claude` branch from `main` instead, and ask if the
  platform-assigned branch should be used regardless before assuming so.
- Non-RC work (housekeeping, docs, hardening) uses a descriptive branch name
  instead of the `rcNN/claude` pattern (e.g. `docs/...`, `fix/...`).

## Standing PR protocol

- Every change goes through a **draft PR** opened from the RC branch against
  `main`. Never push directly to `main`.
- **Never merge or deploy** without explicit authorization from Romeo/Landry
  in the conversation — a Codex "feu vert technique"/approval verdict is a
  review result, not a merge order, and neither is an external bot
  action (draft→ready, approval, merge) taken outside this session; those
  are reported transparently, not treated as this session's own decision.
- Codex performs an independent review on every RC PR before merge. Address
  every blocking finding, push the fix, and report the new head SHA + CI
  status — do not merge in response to a review verdict alone.

## Contract-generalization checklist

When a task generalizes an existing type-specific mechanism (e.g. "make the
Meta-only opportunity logic generic to all providers"), enumerate the fields
of the type(s) being replaced and account for every one of them explicitly —
either carried into the new contract or removed with a stated reason. A
"minimum required fields" list in the task description is a floor, not the
full spec: it does not license dropping fields the old contract already had
just because the new instructions didn't repeat them.

(This caught a real regression in RC21: `MetaFinding.confidence` was dropped
when `buildMetaSourceData()` was generalized into `buildProviderSourceData()`,
because the new contract's stated minimum fields didn't mention it.)
