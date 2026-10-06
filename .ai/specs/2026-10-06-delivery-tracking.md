# Delivery tracking after PR review

## Outcome

A task can finish its coding run while its change still awaits merge and integration CI.
Add a persistent delivery record alongside the existing run lifecycle. This first increment
tracks authoritative PR state, the merged commit, and CI evidence without merging, publishing,
deploying, closing issues, or deleting worktrees itself.

## User flow

- A task with authoritative PR associations offers **Track delivery**.
- Starting tracking explicitly authorizes read-only GitHub queries for those PRs.
- The task shows waiting for merge, CI pending, CI passed, blocked, or unknown, with a
  checked-at timestamp, PR links, commit IDs, individual workflow evidence, and reasons.
- **Refresh delivery** reconciles current GitHub state. Opening a tracked task reads stored
  evidence only; there is no background timer, browser polling, or agent slot held while waiting.
- The existing human-confirmed PR merge box remains the merge surface. A merged PR still
  needs integration evidence; CI passed does not claim release, deployment, or acceptance.
- A server restart preserves the record. A failed refresh preserves useful evidence and
  labels it stale/unknown instead of pretending the previous result is current.

## Boundaries and correctness

- Schemas live first in `packages/contract` and are reused for persistence and wire output.
  The optional run field preserves old records and the current coding lifecycle.
- Routes join the existing chained runs family, validate params/body through middleware,
  and work under both boot and project-scoped `/api/v1` aliases.
- Bind evidence to repository, PR, and full merge commit SHA. Referenced/display-only PR
  URLs cannot silently grant a delivery association. Limit associations to the existing cap.
- CI evidence must come from the merged commit on the target branch, not green PR checks,
  an older commit, an unrelated repository, or a dry-run fixture passed off as real evidence.
- GitHub Actions push runs are discovered with bounded pagination. Prefer the current
  attempt/latest run per workflow. Empty, unreadable, truncated, skipped, cancelled, and
  incomplete results do not establish successful integration. Unknown remains actionable.
- No forge support, no `gh`, missing permissions, offline access, a closed unmerged PR,
  and malformed external output degrade to clear states without breaking task navigation.
- Cross-project reads cannot fetch or persist another project's evidence. Concurrent
  refreshes cannot overwrite a newer PR association or result with an older observation.
- No new dependency, required config, public endpoint, environment variable, or service.

## Verification planned before implementation

Write focused API/integration scenarios first for old records, start/refresh, merged and
unmerged PRs, exact-SHA CI pending/passing/failing, empty and unavailable evidence, closed
unmerged PR, association changes, concurrent refresh, restart durability, and project scope.
Exercise the browser user flow against an isolated fixture, including narrow viewport,
keyboard access, and evidence links. Save screenshots and a JSON/Markdown report under
`.ai/qa/delivery/`; preserve a repeatable E2E spec in the repository.

Run the repository validation gate: typecheck, existing vitest suites, node:test core suite,
build/pack check, and packaged CLI E2E. Report baseline/environment failures separately.

## Following increments

Release/deployment workflow execution, installed/deployed acceptance checks, and tracker
closure will extend delivery tracking once this record and evidence boundary are in place.
