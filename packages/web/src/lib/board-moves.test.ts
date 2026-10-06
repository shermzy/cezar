import { describe, expect, it } from 'vitest'

import { BOARD_COLUMNS, type BoardColumnId } from '@/lib/board-columns'
import {
  BOARD_ORDER_LIMIT,
  applyBoardOrder,
  applyManualOrder,
  moveIntent,
  withColumnOrder,
  type MoveIntent,
  type MoveRun,
} from '@/lib/board-moves'

/**
 * Failure modes of the board's card moves (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c
 * → Moving cards, Testing), written before `board-moves.ts`. Each `describe` is one listed mode.
 */

const running: MoveRun = { status: 'running' }
const waiting: MoveRun = { status: 'waiting' }
const review: MoveRun = { status: 'review' }
const queued: MoveRun = { status: 'queued' }
const scheduled: MoveRun = { status: 'failed', autoResumeAt: '2026-10-04T13:00:00.000Z' }
const done: MoveRun = { status: 'done' }
const failed: MoveRun = { status: 'failed' }
const cancelled: MoveRun = { status: 'cancelled' }

/** The run each column holds in these tests — `boardColumn` is the contract that put it there. */
const IN: Record<BoardColumnId, MoveRun> = {
  queued,
  running,
  'needs-you': waiting,
  review,
  done,
}

const kind = (intent: MoveIntent) => (intent.kind === 'action' ? `action:${intent.action}` : intent.kind)

describe('moveIntent — every from/to pair', () => {
  // The whole 5×5 table, so a pair nobody thought about cannot silently become an action.
  const table: Record<BoardColumnId, Record<BoardColumnId, string>> = {
    queued: { queued: 'refuse', running: 'refuse', 'needs-you': 'refuse', review: 'refuse', done: 'action:cancel' },
    running: { queued: 'refuse', running: 'reorder', 'needs-you': 'refuse', review: 'refuse', done: 'action:cancel' },
    'needs-you': { queued: 'refuse', running: 'refuse', 'needs-you': 'reorder', review: 'refuse', done: 'action:finish' },
    review: { queued: 'refuse', running: 'refuse', 'needs-you': 'refuse', review: 'reorder', done: 'action:accept' },
    done: { queued: 'action:rerun', running: 'refuse', 'needs-you': 'refuse', review: 'refuse', done: 'refuse' },
  }
  for (const from of BOARD_COLUMNS) {
    for (const to of BOARD_COLUMNS) {
      it(`${from} → ${to} is ${table[from][to]}`, () => {
        expect(kind(moveIntent(from, to, IN[from]))).toBe(table[from][to])
      })
    }
  }

  it('a reorder names the column it reorders', () => {
    expect(moveIntent('review', 'review', review)).toEqual({ kind: 'reorder', column: 'review' })
  })

  it('every finished status in Done runs again from Queued — failed and cancelled too', () => {
    for (const run of [done, failed, cancelled]) {
      expect(moveIntent('done', 'queued', run)).toEqual({ kind: 'action', action: 'rerun' })
    }
  })
})

describe('moveIntent — scheduled runs', () => {
  it('a scheduled run in Queued (parked by a usage limit) stops resuming rather than "cancelling" — the cancel route has nothing to cancel', () => {
    expect(moveIntent('queued', 'done', scheduled)).toEqual({ kind: 'action', action: 'stop-resume' })
  })

  it('a really queued run in Queued is cancelled', () => {
    expect(moveIntent('queued', 'done', queued)).toEqual({ kind: 'action', action: 'cancel' })
  })

  it('a scheduled run cannot be reordered or started by hand either', () => {
    expect(kind(moveIntent('queued', 'queued', scheduled))).toBe('refuse')
    expect(kind(moveIntent('queued', 'running', scheduled))).toBe('refuse')
  })
})

describe('moveIntent — refusal reasons', () => {
  const reason = (from: BoardColumnId, to: BoardColumnId) => {
    const intent = moveIntent(from, to, IN[from])
    if (intent.kind !== 'refuse') throw new Error(`${from} → ${to} was not refused`)
    return intent.reason
  }

  it('every refusal says why, in a sentence — never an empty toast', () => {
    for (const from of BOARD_COLUMNS) {
      for (const to of BOARD_COLUMNS) {
        const intent = moveIntent(from, to, IN[from])
        if (intent.kind === 'refuse') expect(intent.reason).toMatch(/^[A-Z].+\.$/)
      }
    }
  })

  it('the agent owns Review and Needs you', () => {
    expect(reason('running', 'review')).toBe('The agent decides when a task needs review.')
    expect(reason('queued', 'needs-you')).toBe('The agent decides when a task needs you.')
  })

  it('Queued keeps cezar’s real start order, and Done is history', () => {
    expect(reason('queued', 'queued')).toBe('Queued tasks start in the order they were queued.')
    expect(reason('done', 'done')).toBe('Done is in the order tasks ended.')
  })

  it('a finished task points at the one move that works', () => {
    for (const to of ['running', 'needs-you', 'review'] as const) {
      expect(reason('done', to)).toBe('To run a finished task again, drop it on Queued.')
    }
  })

  it('a started task cannot go back to the queue', () => {
    for (const from of ['running', 'needs-you', 'review'] as const) {
      expect(reason(from, 'queued')).toBe("A task that has started can't go back to the queue.")
    }
  })
})

describe('applyManualOrder — new runs on top', () => {
  const r = (id: string) => ({ id })

  it('runs missing from the saved list come first, in the default order; then the saved order', () => {
    // Default order (newest first) is n2, a, n1, b — a and b are saved as b, a.
    const out = applyManualOrder([r('n2'), r('a'), r('n1'), r('b')], ['b', 'a'])
    expect(out.map((run) => run.id)).toEqual(['n2', 'n1', 'b', 'a'])
  })

  it('a run that just arrived lands at the top, not under a long saved list', () => {
    const out = applyManualOrder([r('new'), r('x'), r('y')], ['y', 'x'])
    expect(out[0]?.id).toBe('new')
  })
})

describe('applyManualOrder — stale ids', () => {
  const r = (id: string) => ({ id })

  it('ignores ids of runs that left the column, without leaving holes', () => {
    const out = applyManualOrder([r('a'), r('b')], ['gone', 'b', 'also-gone', 'a'])
    expect(out.map((run) => run.id)).toEqual(['b', 'a'])
  })

  it('a duplicated id counts once, at its first place', () => {
    const out = applyManualOrder([r('a'), r('b')], ['b', 'a', 'b'])
    expect(out.map((run) => run.id)).toEqual(['b', 'a'])
  })
})

describe('applyManualOrder — empty', () => {
  const r = (id: string) => ({ id })

  it('no saved list (or an empty one) keeps the default order exactly', () => {
    const runs = [r('a'), r('b'), r('c')]
    expect(applyManualOrder(runs, undefined).map((run) => run.id)).toEqual(['a', 'b', 'c'])
    expect(applyManualOrder(runs, []).map((run) => run.id)).toEqual(['a', 'b', 'c'])
  })

  it('an empty column stays empty whatever was saved', () => {
    expect(applyManualOrder([], ['a', 'b'])).toEqual([])
  })
})

describe('withColumnOrder — the shallow merge', () => {
  it('saving one column keeps the other columns’ saved orders (PUT /ui-state replaces `board` whole)', () => {
    const next = withColumnOrder({ order: { running: ['r1'], review: ['v1', 'v2'] } }, 'review', ['v2', 'v1'])
    expect(next).toEqual({ order: { running: ['r1'], review: ['v2', 'v1'] } })
  })

  it('keeps keys of `board` it does not know, so a newer cockpit’s prefs survive', () => {
    const next = withColumnOrder({ order: {}, collapsed: { done: true } }, 'running', ['a'])
    expect(next).toEqual({ order: { running: ['a'] }, collapsed: { done: true } })
  })

  it('starts from nothing when nothing was saved', () => {
    expect(withColumnOrder(undefined, 'needs-you', ['a', 'b'])).toEqual({ order: { 'needs-you': ['a', 'b'] } })
  })

  it(`never saves more than ${BOARD_ORDER_LIMIT} ids — the top of the column is what is kept`, () => {
    const ids = Array.from({ length: BOARD_ORDER_LIMIT + 5 }, (_, i) => `id-${i}`)
    const saved = withColumnOrder(undefined, 'running', ids).order?.running ?? []
    expect(saved).toHaveLength(BOARD_ORDER_LIMIT)
    expect(saved[0]).toBe('id-0')
  })
})

describe('applyBoardOrder and withColumnOrder — a hand-edited ui-state', () => {
  // `readUiState` does not validate the file (`packages/cezar/src/ui-state.ts`), so whatever a
  // person typed into `.ai/cezar/ui-state.json` reaches the board as-is.
  const r = (id: string) => ({ id })
  const ids = (runs: readonly { id: string }[]) => runs.map((run) => run.id)
  const columns = {
    queued: [],
    running: [r('a'), r('b')],
    'needs-you': [r('c')],
    review: [r('d'), r('e')],
    done: [],
  }

  it('a saved order that is not a list of ids is no order — never a crash, never a string read as ids', () => {
    const out = applyBoardOrder(columns, { running: 'b,a', 'needs-you': 7, review: ['e', 3, null, 'd'] })
    expect(ids(out.running)).toEqual(['a', 'b'])
    expect(ids(out['needs-you'])).toEqual(['c'])
    // The strings in a mixed list still count; the rest is dropped.
    expect(ids(out.review)).toEqual(['e', 'd'])
    expect(ids(applyBoardOrder(columns, 'garbage').running)).toEqual(['a', 'b'])
  })

  it('a reorder writes a sane board over a corrupt one, and keeps its other keys', () => {
    expect(withColumnOrder({ order: ['x'], note: 1 }, 'running', ['a'])).toEqual({ order: { running: ['a'] }, note: 1 })
    expect(withColumnOrder('junk', 'review', ['a'])).toEqual({ order: { review: ['a'] } })
  })
})
