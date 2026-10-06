import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from './store.ts';

/**
 * Which agent, account and model a task is on — the three optional keys the slim cross-project
 * rows carry (`runIndexEntrySchema`: `GET /workspace/runs-index`, and the dashboard's task rows,
 * which share the schema). Spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c.
 *
 * The rows deliberately carry no `steps[]`, so the account a task RAN on has to be read here:
 * - `accountId` — the LAST step that recorded a `profileId` (a step's account owns its session, so
 *   it is what actually ran), else the task's own pick (`agentProfile`), else absent. Never a
 *   guessed `default`: a task that followed its project's selection may be about to use any account.
 * - `runner` — the task's own, else the backend its last step ran on, else absent. The project's
 *   `defaultRunner` is not applied here: a cockpit reading another project's row does not hold
 *   that project's config, and an honest "not known yet" beats the wrong agent.
 * - `model` — verbatim; absent means the runner picks.
 *
 * The cockpit applies the same rule to full records (`packages/web/src/lib/agent-summary.ts`).
 * Optional keys are spread conditionally, like every other key of the row: an `undefined` value
 * would type a key as present that `JSON.stringify` then drops.
 */
export function runAgentFields(
  run: Pick<RunRecord, 'steps'> & Partial<Pick<RunRecord, 'runner' | 'model' | 'agentProfile'>>,
): { runner?: RunnerId; model?: string; accountId?: string } {
  let ranOn: string | undefined;
  let backend: RunnerId | undefined;
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    ranOn ??= step?.profileId;
    backend ??= step?.backend;
    if (ranOn !== undefined && backend !== undefined) break;
  }
  const runner = run.runner ?? backend;
  const accountId = ranOn ?? run.agentProfile;
  return {
    ...(runner !== undefined ? { runner } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
  };
}
