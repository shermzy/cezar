import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import { rerunBody, type RerunContext, type RerunRun } from '@/lib/rerun-body'

/**
 * Failure modes of "Run again as a new task" (spec `.ai/specs/2026-10-04-kanban-board.md`
 * § Phase 1c → Moving cards, `rerunBody`), written before `rerun-body.ts`. Each one is a body
 * `POST /runs` would refuse, or a setting the re-run would silently lose or invent.
 */

/** A task that started: `execute` records `runner` on every run it starts (`run.ts`), so a real
 *  finished record always names one. */
function run(over: Partial<RerunRun> = {}): RerunRun {
  return { task: 'Fix the flaky test', workflow: 'quick-task', runner: 'claude', steps: [], ...over }
}

/** A step that ran under `profileId` — what the task header and the card read as "ran on". */
const ranOn = (profileId: string): RunRecord['steps'][number] => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  profileId,
})

const ctx = (over: Partial<RerunContext> = {}): RerunContext => ({
  modelsLocked: false,
  defaultRunner: 'claude',
  profiles: [
    { id: 'work', provider: 'claude' },
    { id: 'codex-work', provider: 'codex' },
  ],
  ...over,
})

/** The whole answer of a re-run that was not refused, or a failed test naming the refusal. */
function rerun(input: RerunRun, context = ctx()) {
  const result = rerunBody(input, context)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result
}

const body = (input: RerunRun, context = ctx()) => rerun(input, context).body

const PLAN: NonNullable<RunRecord['workflowDef']> = {
  name: '(planned)',
  source: 'built-in',
  steps: [
    { id: 'plan', name: 'Plan', prompt: '{{task}}' },
    { id: 'build', name: 'Build', prompt: 'Implement it' },
  ],
}

describe('a planned chain', () => {
  it('re-sends its recorded steps — never the "(planned)" pseudo-name, which POST /runs answers 404', () => {
    const sent = body(run({ workflow: '(planned)', workflowDef: PLAN }))
    expect(sent.steps).toEqual(PLAN.steps)
    expect(sent).not.toHaveProperty('workflow')
  })

  it('a catalog workflow is re-sent by name, with the same task and the runner it ran on', () => {
    expect(body(run())).toEqual({ task: 'Fix the flaky test', workflow: 'quick-task', runner: 'claude' })
  })

  it('a chain whose steps were not recorded is refused with a reason, not sent half-built', () => {
    const result = rerunBody(run({ workflow: '(planned)' }), ctx())
    expect(result).toEqual({ ok: false, reason: "This task's plan wasn't saved with it, so it can't be run again." })
  })

  it('a chain longer than POST /runs takes (8 steps) is refused', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, prompt: '{{task}}' }))
    const result = rerunBody(run({ workflow: '(planned)', workflowDef: { ...PLAN, steps } }), ctx())
    expect(result.ok).toBe(false)
  })
})

describe('locked models', () => {
  it('omits the model when the project locks models — POST /runs answers 409 to any model then — and says so', () => {
    const locked = rerun(run({ model: 'opus' }), ctx({ modelsLocked: true }))
    expect(locked.body).not.toHaveProperty('model')
    expect(locked.dropped).toEqual({ model: 'opus' })
  })

  it('copies the model when it is not locked, and drops nothing', () => {
    const open = rerun(run({ model: 'opus' }))
    expect(open.body.model).toBe('opus')
    expect(open.dropped).toEqual({})
  })
})

describe('a removed account', () => {
  it('keeps the account the task RAN on while its agent still has it', () => {
    expect(body(run({ agentProfile: 'default', steps: [ranOn('work')] })).agentProfile).toBe('work')
  })

  it('omits an account that no longer exists — the new task follows its project instead of a 400 — and says so', () => {
    const gone = rerun(run({ agentProfile: 'deleted' }))
    expect(gone.body).not.toHaveProperty('agentProfile')
    expect(gone.dropped).toEqual({ account: 'deleted' })
  })

  it('omits an account of ANOTHER agent (a mixed chain’s last step) — POST /runs checks it against the runner', () => {
    expect(body(run({ runner: 'claude', steps: [ranOn('codex-work')] }))).not.toHaveProperty('agentProfile')
  })

  it('a task that never started (no runner recorded) is checked against the project’s default runner', () => {
    const neverStarted = run({ runner: undefined, agentProfile: 'codex-work' })
    expect(body(neverStarted, ctx({ defaultRunner: 'codex' })).agentProfile).toBe('codex-work')
    expect(body(neverStarted, ctx({ defaultRunner: 'claude' }))).not.toHaveProperty('agentProfile')
  })

  it('the discovered account always exists', () => {
    expect(body(run({ agentProfile: 'default' }), ctx({ profiles: [] })).agentProfile).toBe('default')
  })
})

describe('worktree false or absent', () => {
  it('copies worktree: false', () => {
    expect(body(run({ worktree: false })).worktree).toBe(false)
  })

  it('absent stays absent — the default isolated worktree is never spelled out', () => {
    expect(body(run())).not.toHaveProperty('worktree')
  })

  it('copies autonomous: true and generateFollowups: false, and sends neither when they are the default', () => {
    const sent = body(run({ autonomous: true, generateFollowups: false }))
    expect(sent.autonomous).toBe(true)
    expect(sent.generateFollowups).toBe(false)
    const plain = body(run({ autonomous: false, generateFollowups: true }))
    expect(plain).not.toHaveProperty('autonomous')
    expect(plain).not.toHaveProperty('generateFollowups')
  })

  it('pins the runner the task ran on; a task cancelled before it started sends none and follows the project', () => {
    expect(body(run({ runner: 'codex' })).runner).toBe('codex')
    expect(body(run({ runner: undefined }))).not.toHaveProperty('runner')
  })
})

describe('no attachments', () => {
  /** Every key `POST /runs` may receive from a re-run — and nothing a full record carries besides. */
  const ALLOWED = ['task', 'workflow', 'steps', 'runner', 'model', 'agentProfile', 'autonomous', 'generateFollowups', 'worktree']

  it('sends only the copied keys — never attachments, variants, dispatch, the system prompt or the record’s own fields', () => {
    // A finished record as the server keeps it, with everything a re-run must NOT carry over.
    const record: RunRecord = {
      id: 'r1',
      title: 'fix the flaky test',
      titleSummary: 'Fix the flaky test',
      workflow: 'quick-task',
      task: 'Fix the flaky test',
      status: 'done',
      createdAt: '2026-10-04T10:00:00.000Z',
      startedAt: '2026-10-04T10:00:01.000Z',
      finishedAt: '2026-10-04T10:05:00.000Z',
      tokensUsed: 1200,
      archived: false,
      runner: 'claude',
      model: 'opus',
      agentProfile: 'work',
      autonomous: true,
      generateFollowups: false,
      worktree: false,
      taskImages: ['/api/v1/runs/r1/images/pasted-1.png'],
      systemPrompt: 'Be terse.',
      variant: 'A',
      groupId: 'g1',
      dispatch: { rootRunId: 'r1' },
      branch: 'cez/r1',
      costUsd: 0.12,
      pinned: true,
      seenAt: '2026-10-04T10:06:00.000Z',
      steps: [ranOn('work')],
    }
    const sent = body(record)
    expect(Object.keys(sent).filter((key) => !ALLOWED.includes(key))).toEqual([])
    expect(sent).toEqual({
      task: 'Fix the flaky test',
      workflow: 'quick-task',
      runner: 'claude',
      model: 'opus',
      agentProfile: 'work',
      autonomous: true,
      generateFollowups: false,
      worktree: false,
    })
  })
})
