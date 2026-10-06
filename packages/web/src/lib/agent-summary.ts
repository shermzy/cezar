import {
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentProfile,
  type RunRecord,
  type StepState,
} from '@open-mercato/cezar-api-client'

/**
 * "Which agent is working on which issue" (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c):
 * one rule and one format — `runner · account · model` — for the Board card's top line and the
 * task header's agent badge (`routes/task-thread/run-header.tsx`). Pure; `agent-summary.test.ts`
 * holds the failure modes.
 */

/** What the summary reads. A full record has `steps`; a cross-project index row has none, and
 *  carries the server's own derivation of the same rule in `runner` and `accountId` instead
 *  (`packages/cezar/src/runs/run-agent.ts`). */
export type AgentSummaryInput = Partial<Pick<RunRecord, 'runner' | 'model' | 'agentProfile'>> & {
  steps?: readonly Partial<Pick<StepState, 'profileId' | 'backend'>>[]
  accountId?: string
}

/** One row of `GET /workspace/agent-profiles` — all the label lookup needs. */
export type AccountRow = Pick<AgentProfile, 'id' | 'provider' | 'label' | 'isDefault'>

export interface AgentSummary {
  runner: string
  /** The account's label; absent when nothing ran and nothing was asked for. */
  account?: string
  model: string
  /** `runner · account · model` */
  text: string
}

/** `runner · account · model`, with an absent account leaving no empty segment and an absent
 *  model reading `auto` (the runner picks it). */
export function formatAgentSummary({
  runner,
  accountLabel,
  model,
}: {
  runner: string
  accountLabel?: string
  model?: string
}): string {
  return [runner, accountLabel, model || 'auto'].filter(Boolean).join(' · ')
}

/**
 * The account a task ran on: the LAST step that recorded one (a step's `profileId` is the account
 * that owns its session, so it is what actually ran), else the task's own pick (`agentProfile` —
 * what a queued task will spawn under), else nothing. Never a guessed `default`: a task that
 * followed its project's selection and has not started yet may be about to use any account.
 */
export function effectiveAccountId(run: Pick<AgentSummaryInput, 'steps' | 'agentProfile' | 'accountId'>): string | undefined {
  if (run.accountId !== undefined) return run.accountId
  const steps = run.steps ?? []
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const profileId = steps[index]?.profileId
    if (profileId) return profileId
  }
  return run.agentProfile
}

/**
 * An account id → the label the cockpit shows. The discovered account's id is `default` for EVERY
 * agent, so it is looked up per provider — that is also where a renamed Default login's new name
 * lives. A stored id is unique across providers. A removed account keeps its id, marked removed;
 * but while the list is still loading nothing is claimed removed.
 */
function accountLabel(
  accountId: string | undefined,
  provider: string,
  profiles: readonly AccountRow[] | undefined,
): string | undefined {
  if (accountId === undefined) return undefined
  if (accountId === DEFAULT_AGENT_ACCOUNT_ID) {
    return profiles?.find((profile) => profile.isDefault && profile.provider === provider)?.label ?? 'Default'
  }
  if (profiles === undefined) return accountId
  return profiles.find((profile) => profile.id === accountId)?.label ?? `${accountId} (removed)`
}

/**
 * The summary for one run, or `undefined` when no runner is known at all — a queued row of the
 * cross-project index that asked for no runner, whose project default this page does not hold.
 *
 * The runner is the task's own, else the one its last step ran on (`backend`), else the project's
 * `defaultRunner` (`run.ts` runs `input.runner ?? config.defaultRunner`).
 */
export function agentSummary(
  run: AgentSummaryInput,
  { defaultRunner, profiles }: { defaultRunner?: string; profiles?: readonly AccountRow[] },
): AgentSummary | undefined {
  const runner = run.runner ?? lastStepBackend(run.steps) ?? defaultRunner
  if (runner === undefined) return undefined
  const account = accountLabel(effectiveAccountId(run), runner, profiles)
  const model = run.model || 'auto'
  return {
    runner,
    ...(account !== undefined ? { account } : {}),
    model,
    text: formatAgentSummary({ runner, accountLabel: account, model }),
  }
}

function lastStepBackend(steps: AgentSummaryInput['steps']): string | undefined {
  for (let index = (steps?.length ?? 0) - 1; index >= 0; index -= 1) {
    const backend = steps?.[index]?.backend
    if (backend) return backend
  }
  return undefined
}
