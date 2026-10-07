# Workspace specialists: standby roles across projects

Status: approved for local implementation.
Date: 2026-10-05.

## Goal

Let the user keep a small roster of named specialist roles available across every project registered in this Cezar workspace, assign them to work, and see their assignments together.

“Standby” means the role definition is saved and available. It does not keep an agent process or session alive. Work starts only after an explicit assignment.

## Product shape

- Add built-in Planner, Implementer, and Reviewer roles. Built-ins are read-only; the user can clone one to create a custom role with a name, description, and bounded instructions.
- Store custom roles at workspace scope. A role selects no provider account, runner, model, or credential. Each assignment uses the selected project’s normal runner, account, model, tool, and worktree resolution.
- Add a workspace Agents page with role management and a combined assignment list grouped by project. A role can have multiple project assignments; each is an ordinary run with its own task thread.
- Assignment selects exactly one registered project and uses the existing task composer and run lifecycle. A user can create a new task in another project and explicitly carry a handoff note they wrote or approved. The handoff contains only that note and a source task link; it does not copy transcripts, attachments, repository files, account identity, or session state.
- Existing same-project dispatch can optionally name a specialist for a child task. The normal dispatch engine still owns child limits, budget carving, reports, cancellation, and worktrees.
- Show the specialist identity on the task and workspace run index. Snapshot its ID, name, and instruction text before the run is queued. Editing or deleting a role changes future assignments only.

## Roles are guidance, not permission profiles

Planner, Reviewer, and custom role instructions affect the task prompt only. They do not make a backend read-only or restrict its tools. Keep tool permissions, project access, provider identity, and review policy under their existing controls. Never present a role as a security boundary.

## Lifecycle

The roster has no independent execution state machine.

- Standby: no assignment run is queued, running, or waiting.
- Working: one or more ordinary runs for the role are queued, running, or waiting.
- Needs attention: an assignment is failed, waiting for user input, or has changes at the normal review gate.
- Unavailable: the selected project or its configured backend cannot accept a run; report the existing refusal and keep the task with its selected project.

Existing run transitions and the workspace run index supply these states. Assignment, task continuation/message, and same-project dispatch are the only wake sources. There is no heartbeat, watcher, or background task queue for idle roles.

## Project isolation and review

- Each assignment has one project ID, one project run store, one worktree, and one vendor session. The same role assigned twice creates two independent runs.
- Cross-project handoff is explicit and user initiated. The user chooses the target project and confirms the handoff note before a normal target-project run is created.
- Do not reuse a session, implicit provider account, transcript, attachment, or repository path across projects.
- Assignment roots run through the normal review policy. They must not be marked autonomous in a way that skips the review status when a diff exists. Never merge to a base branch automatically.
- Existing workspace concurrency and per-run budgets remain authoritative. A specialist identity is not a new parallel slot.

This is workspace coordination across project-bound tasks, not a multi-repository checkout in one run. Multi-repository worktree sets and reusable project sets remain a separate feature and are not a dependency.

## Persistence and recovery

- Built-in definitions are code defaults. Custom definitions live in cezarHomeDir()/specialists.json, separate from workspace config and agent-account files.
- Missing state yields the built-ins. Corrupt, unreadable, or read-only state degrades to the built-ins plus one clear warning; it must not stop server boot or ordinary runs.
- Writes use the existing workspace atomic JSON read/modify/write conventions and are sandboxed under CEZ_HOME in tests.
- Store an immutable role snapshot in the run record before queueing. Initial execution, continuation, restart recovery, and dispatch-child execution use that same snapshot.
- Deleting a role prevents future selection but does not erase role provenance from existing runs.
- Listing roles and cross-project status is read-only. Use workspace run-index data or existing read-only run readers; do not instantiate every ProjectContext, because context creation performs recovery and may launch old work.

## API and UI

- Define request, response, and persisted record schemas in packages/contract; infer types from Zod.
- Add a chained, workspace-level specialist CRUD API under /api/v1/workspace/specialists. Validate every body and path parameter with the existing route middleware.
- Add optional specialist selection to normal run creation and same-project dispatch. Run and dispatch routes keep their project-scoped aliases. Unknown or deleted specialist IDs are a clear client error; never silently fall back to an unspecialized run.
- Add the role snapshot to run records and the compact role identity to the workspace run index, preserving the exact JSON wire shape and backward-compatible optionality.
- Add /agents as a workspace page. Respect the current cockpit’s project visibility; a single-project or remote view must not reveal excluded projects.
- Reuse the task composer, task-thread links, workspace run-index invalidation, keyboard-accessible controls, and responsive patterns. Do not add another WebSocket topic or polling timer.

## Non-goals

No warm persistent sessions, idle token use, autonomous project scanning, automatic cross-project delegation, specialist-to-specialist chat, global agent memory, new scheduler, multi-repository worktree set, or automatic merge.

## Acceptance criteria

1. Opening /agents makes no agent launch, recovery, provider probe, or poll request.
2. A custom role can be created, edited, cloned, deleted, and survives restart; invalid role data and unknown IDs are rejected.
3. The same role can be explicitly assigned to two projects; the runs use project-local account resolution, run store, worktree, session, and task links.
4. A cross-project handoff requires a human-confirmed note and target project; no other task or project data is copied.
5. A queued run edited or deleted from the source role before restart retains the original instruction snapshot after recovery.
6. Role selection for a same-project dispatched child preserves the existing child budget, fan-out, report, cancellation, and review behavior.
7. Root assignments with a diff still reach the ordinary human review gate.
8. Opening the role roster/status view does not recover unopened projects.
9. Missing/corrupt/read-only specialist storage leaves normal cockpit use available.
10. All new API routes are chained, versioned, project-scope parity is exact, and BACKWARD_COMPATIBILITY.md is updated.