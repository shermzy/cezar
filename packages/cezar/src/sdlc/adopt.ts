import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { SDLC_BASELINE_WORKFLOW } from '../workflows/types.ts';

/** The slice of a project context adoption needs; keeps the function testable without a server. */
export interface AdoptionTarget {
  store: Pick<RunStore, 'listRuns'>;
  manager: Pick<RunManager, 'startRun'>;
}

const OPEN = new Set(['queued', 'running', 'waiting', 'review']);

/**
 * Start the baseline adoption task for one project (spec 2026-10-06-ai-native-sdlc-fleet).
 *
 * It is an ordinary task running the built-in `sdlc-baseline` workflow, so it inherits worktree
 * isolation, the workspace parallel cap and the review gate. The built-in definition is used
 * directly: a repository workflow file named `sdlc-baseline` must not be able to substitute other
 * commands for something launched from the fleet view.
 *
 * One adoption at a time per project: a second request returns the task already in flight,
 * including one waiting at the review gate, instead of stacking a duplicate.
 */
export function startAdoption(target: AdoptionTarget): { runId: string } {
  const open = target.store.listRuns().find((run) => run.workflow === SDLC_BASELINE_WORKFLOW.name && OPEN.has(run.status));
  if (open) return { runId: open.id };
  return { runId: target.manager.startRun(SDLC_BASELINE_WORKFLOW, { task: 'Adopt the AI-native SDLC baseline' }).id };
}
