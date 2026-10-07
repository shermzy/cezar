# Workspace specialists implementation plan

Delivery: merge through a PR into the user's personal fork, `shermzy/cezar:main`. The upstream Open Mercato `origin` remains out of scope.
Spec: .ai/specs/2026-10-05-workspace-specialists.md
Branch: codex/workspace-specialists

## Guardrails

- Preserve unrelated changes in the original checkout; implement only in the managed feature worktree.
- Keep the default roster passive. Assignments are explicit and start normal project runs.
- Never copy account credentials, sessions, attachments, or repository paths across project boundaries.
- Preserve dispatch limits/budgets and the ordinary human review gate. No automatic merge.
- Define API and persisted shapes in packages/contract first; chain Hono routes and validate at middleware.
- For each new state or route, enumerate all constructors/recovery paths before changing it.
- E2E-first per repository instructions: write the failure scenarios and focused browser scenario before implementation. Keep one repeatable report artifact.

## Failure cases to pin before production code

1. Opening Agents accidentally constructs every project context, runs recovery, or starts an agent.
2. Unknown/deleted role IDs silently fall back and start an unowned task.
3. Editing/deleting a role while a run is queued changes its prompt after restart.
4. A run or handoff carries vendor session, credential, attachment, transcript, or source-repo data into another project.
5. A role bypasses the existing maxParallel gate or a run budget.
6. A root assignment is marked autonomous and bypasses review despite a diff.
7. A corrupt/read-only role file prevents boot or ordinary run creation.
8. A hidden project appears in the roster or can be targeted from a restricted cockpit.
9. Status is stale or wrong after continuation, failure, cancellation, review, or restart.
10. Selecting a specialist for a dispatch child changes child caps, budget carving, report delivery, or cancellation.

## Execution steps

1. [x] Review current dispatch, workspace registry, project-context recovery, and role/account separation. Freeze the MVP boundaries in the spec.
2. [x] After the user directed us not to touch the upstream repository, close temporary issue #1284 created before that correction and remove its project card. No issue or project item remains for this work.
3. [x] Add contract schemas for specialist definitions/snapshots, CRUD inputs/outputs, optional run selection, dispatch selection, and run-index identity. Keep run fields optional for old records.
4. [x] Add a workspace specialist store with immutable built-ins, custom-role CRUD, atomic writes, per-entry salvage, CEZ_HOME isolation, and one warning on degraded state.
5. [x] Thread a role snapshot through every run construction path: new runs, queued recovery, continuation, and dispatch child. Persist before queue; compose role instructions only from the snapshot. Keep assignment roots non-autonomous.
6. [x] Add the chained workspace CRUD route family and role resolution for run creation/dispatch. Derive cross-project status from the existing workspace run index without constructing ProjectContexts.
7. [x] Add /agents, role CRUD controls, explicit project assignment and confirmed handoff note, role status grouped by project, and role badges/links on runs. Respect route visibility, keyboard access, narrow widths, and existing API hooks.
8. [x] Update CLI/dispatch prompt for optional specialist selection, BACKWARD_COMPATIBILITY.md route inventory, and concise user documentation.
9. [x] Run `npm run test --workspace @open-mercato/cezar-web -- --config e2e/workspace-specialists-isolated.vitest.config.ts` with an isolated CEZ_HOME, two temporary Git projects, and CEZ_DRY_RUN=1. The feature-only branch based on the personal fork's `main` passed both scenarios; intermittent earlier runs timed out in the local Agent Browser while opening `/agents`, and subsequent retries passed. The latest report and screenshot are `.ai/qa/artifacts_e2e/workspace-specialists.json` and `.ai/qa/artifacts_e2e/workspace-specialists.png`. Current-source full workspace typecheck and production build pass. Focused contract-parity, typed-body, versioned-surface, and route-inventory checks pass (24 tests). `route-parity.test.ts` passes 8/9 when isolated with a 30s timeout; the remaining test fails in Windows fixture cleanup with `EPERM` at `rmSync`, while the combined default-timeout run also times out its slow all-route case. No unrelated test cleanup changes were made. Dry-run produced no diff, so the ordinary review gate was verified through `autonomous: false` but not entered.
10. [x] Review the complete diff: run snapshots cover new, queued-recovery, continuation, and dispatch paths; specialist identity is optional on old records and compact in the index; single-project filtering limits both roster project rows and the workspace index; handoff carries only the user-authored note and source task link; `git diff --check` is clean. No environment variable, dependency, background process, or upstream change is part of the implementation.
11. [x] Create a focused local commit. The user's later delivery authorization is limited to their personal fork; do not push to or open a PR against upstream Open Mercato.

## Delivery checklist

- Only the spec, implementation plan, feature source, targeted E2E/contract checks, route inventory, and result artifact are in the commit.
- No new CEZ_* variable or dependency.
- Report exact checks and results, the local branch/commit, the upstream-write cleanup, and cleanup of task-owned processes.
