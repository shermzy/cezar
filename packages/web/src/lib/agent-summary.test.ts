import { describe, expect, it } from 'vitest'

import { agentSummary, effectiveAccountId, formatAgentSummary, type AccountRow } from '@/lib/agent-summary'

/**
 * Failure modes of "which agent is working on which issue" (spec
 * `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Which agent on which issue), written before
 * `agent-summary.ts`. The card's top line and the task header's agent badge both read these, so a
 * mode broken here is broken in both places.
 */

const PROFILES: AccountRow[] = [
  // The Default logins can be renamed (hosted-accounts H2, `defaultLabels`): the label is the
  // listing's, per provider.
  { id: 'default', provider: 'claude', label: 'T3 team', isDefault: true },
  { id: 'default', provider: 'codex', label: 'Default', isDefault: true },
  { id: 'work', provider: 'claude', label: 'Work', isDefault: false },
]

describe('formatAgentSummary — one format everywhere: runner · account · model', () => {
  it('joins the three parts', () => {
    expect(formatAgentSummary({ runner: 'claude', accountLabel: 'Work', model: 'opus' })).toBe('claude · Work · opus')
  })

  it('an absent account leaves no empty segment and no doubled separator', () => {
    expect(formatAgentSummary({ runner: 'codex', model: 'gpt-5.2-codex' })).toBe('codex · gpt-5.2-codex')
  })

  it('an absent or empty model reads "auto" — the runner picks it', () => {
    expect(formatAgentSummary({ runner: 'claude', accountLabel: 'Work' })).toBe('claude · Work · auto')
    expect(formatAgentSummary({ runner: 'claude', model: '' })).toBe('claude · auto')
  })
})

describe('effectiveAccountId — what ran, else what was asked, else nothing', () => {
  it('the last step that recorded an account wins over the task’s own pick', () => {
    expect(
      effectiveAccountId({ agentProfile: 'default', steps: [{ profileId: 'work' }, { profileId: 'other' }, {}] }),
    ).toBe('other')
  })

  it('a task no step has run yet (queued) names the account it asked for', () => {
    expect(effectiveAccountId({ agentProfile: 'work', steps: [] })).toBe('work')
  })

  it('nothing recorded and nothing asked is NO account — never a guessed "default"', () => {
    expect(effectiveAccountId({ steps: [{}] })).toBeUndefined()
  })

  it('a cross-project index row carries the server-derived account as-is', () => {
    expect(effectiveAccountId({ accountId: 'work' })).toBe('work')
  })
})

describe('agentSummary — runner and account labels', () => {
  it('names a stored account by its label', () => {
    const summary = agentSummary({ runner: 'claude', model: 'opus', steps: [{ profileId: 'work' }] }, { profiles: PROFILES })
    expect(summary?.text).toBe('claude · Work · opus')
  })

  it('names the discovered account by ITS PROVIDER’s label, so a renamed Default shows its new name', () => {
    expect(agentSummary({ runner: 'claude', steps: [{ profileId: 'default' }] }, { profiles: PROFILES })?.account).toBe(
      'T3 team',
    )
    // The same id on another agent is another login: codex's Default is not claude's "T3 team".
    expect(agentSummary({ runner: 'codex', steps: [{ profileId: 'default' }] }, { profiles: PROFILES })?.account).toBe(
      'Default',
    )
  })

  it('a removed account is still named, and said to be removed', () => {
    expect(agentSummary({ runner: 'claude', steps: [{ profileId: 'gone' }] }, { profiles: PROFILES })?.account).toBe(
      'gone (removed)',
    )
  })

  it('while the account list is loading, never claims an account was removed', () => {
    expect(agentSummary({ runner: 'claude', steps: [{ profileId: 'work' }] }, {})?.account).toBe('work')
    expect(agentSummary({ runner: 'claude', steps: [{ profileId: 'default' }] }, {})?.account).toBe('Default')
  })

  it('the runner is the task’s own, else the one its last step ran on, else the project default', () => {
    expect(agentSummary({ runner: 'codex', steps: [{ backend: 'claude' }] }, { defaultRunner: 'claude' })?.runner).toBe(
      'codex',
    )
    expect(agentSummary({ steps: [{ backend: 'codex' }] }, { defaultRunner: 'claude' })?.runner).toBe('codex')
    expect(agentSummary({ steps: [] }, { defaultRunner: 'opencode' })?.runner).toBe('opencode')
  })

  it('with no runner known at all (a queued cross-project row), says nothing rather than guessing', () => {
    expect(agentSummary({ steps: [] }, { profiles: PROFILES })).toBeUndefined()
  })
})
