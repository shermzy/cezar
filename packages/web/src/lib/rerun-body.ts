import {
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentProfile,
  type CreateRunInput,
  type RunRecord,
  type Runner,
} from '@open-mercato/cezar-api-client'

import { effectiveAccountId } from '@/lib/agent-summary'

/**
 * "Run again as a new task" (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Moving
 * cards): the `POST /runs` body that starts the same task again. Pure; `rerun-body.test.ts` holds
 * the failure modes — each one a body the route would refuse, or a setting the re-run would lose
 * or invent.
 *
 * Copied: the task text, the workflow (or a planned chain's recorded steps), the runner, the model
 * (not when the project locks models), the account the task ran on (only while its agent still
 * has it), `autonomous`, `generateFollowups: false` and `worktree: false`. NOT copied:
 * attachments, variants and dispatch — the confirm dialog says attachments are not.
 *
 * The runner is pinned for every task that started: `execute` writes `runner: taskBackend` onto
 * the record when it starts (`packages/cezar/src/workflows/run.ts`), so a re-run runs on the agent
 * the original ran on, even if the project's default changed since. Only a task that never
 * started (cancelled in the queue) has no runner, and its re-run follows the project default.
 *
 * What a re-run drops on purpose — a locked model, an account the runner no longer has — is
 * reported in `dropped`, so the dialog can say so before anything is sent.
 */

/** The record fields a re-run reads. A full `ApiRun` satisfies it; an index row does not (no
 *  `task`, no `steps`), which is why the All-boards board fetches the record first. */
export type RerunRun = Pick<RunRecord, 'task' | 'workflow' | 'steps'> &
  Partial<
    Pick<RunRecord, 'workflowDef' | 'runner' | 'model' | 'agentProfile' | 'autonomous' | 'generateFollowups' | 'worktree'>
  >

export interface RerunContext {
  /** The project's `modelsLocked` (`GET /config`): `POST /runs` answers 409 to any model then. */
  modelsLocked: boolean
  /** The project's `defaultRunner` — what `POST /runs` checks an account against when the body
   *  names no runner (`server.ts`: `runner ?? config.defaultRunner`). */
  defaultRunner: Runner
  /** `GET /workspace/agent-profiles` rows: which accounts each agent has NOW. */
  profiles: readonly Pick<AgentProfile, 'id' | 'provider'>[]
}

export type Rerun =
  | { ok: true; body: CreateRunInput; dropped: { model?: string; account?: string } }
  | { ok: false; reason: string }

/** The pseudo-workflow a run started from inline `steps` carries — a plan, or a composer skill. */
export const PLANNED_WORKFLOW = '(planned)'
/** `POST /runs` takes at most this many inline steps (`startRunSchema`). */
const MAX_INLINE_STEPS = 8

export function rerunBody(run: RerunRun, ctx: RerunContext): Rerun {
  let source: Pick<CreateRunInput, 'workflow' | 'steps'>
  if (run.workflow === PLANNED_WORKFLOW) {
    // "(planned)" names no catalog entry — `POST /runs` would answer 404 unknown workflow. The
    // chain only exists on the record.
    const steps = run.workflowDef?.steps ?? []
    if (steps.length === 0) {
      return { ok: false, reason: "This task's plan wasn't saved with it, so it can't be run again." }
    }
    if (steps.length > MAX_INLINE_STEPS) {
      return {
        ok: false,
        reason: `This task's plan has ${steps.length} steps; a new task can take at most ${MAX_INLINE_STEPS}.`,
      }
    }
    source = { steps: [...steps] }
  } else {
    source = { workflow: run.workflow }
  }

  const askedModel = run.model?.trim() || undefined
  const model = ctx.modelsLocked ? undefined : askedModel
  // `POST /runs` 400s an account that is not one of THIS runner's (`resolveWorkspaceProfile`): a
  // removed one, or — after a mixed chain — the last step's account of another agent. Either way
  // the new task follows its project rather than failing.
  const account = effectiveAccountId(run)
  const provider = run.runner ?? ctx.defaultRunner
  const keepAccount =
    account !== undefined &&
    (account === DEFAULT_AGENT_ACCOUNT_ID ||
      ctx.profiles.some((profile) => profile.id === account && profile.provider === provider))

  return {
    ok: true,
    body: {
      task: run.task,
      ...source,
      ...(run.runner !== undefined ? { runner: run.runner } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(keepAccount ? { agentProfile: account } : {}),
      ...(run.autonomous === true ? { autonomous: true } : {}),
      ...(run.generateFollowups === false ? { generateFollowups: false } : {}),
      ...(run.worktree === false ? { worktree: false } : {}),
    },
    dropped: {
      ...(askedModel !== undefined && model === undefined ? { model: askedModel } : {}),
      ...(account !== undefined && !keepAccount ? { account } : {}),
    },
  }
}
