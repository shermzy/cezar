import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@open-mercato/cezar-api-client'
import { BOARD_COLUMNS, DONE_WINDOW_MS, boardColumn, groupBoard, type BoardColumnId } from '@/lib/board-columns'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-10-01T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const NOW = Date.parse('2026-10-04T12:00:00.000Z')

/** `column: id, id` per column — placement and order are the assertion, not whole records. */
function shape(columns: Record<BoardColumnId, RunRecord[]>): Record<BoardColumnId, string[]> {
  return Object.fromEntries(
    BOARD_COLUMNS.map((id) => [id, columns[id].map((r) => r.id)]),
  ) as Record<BoardColumnId, string[]>
}

describe('boardColumn — every status lands in exactly the spec column', () => {
  it.each([
    ['queued', {}, 'queued'],
    ['running', {}, 'running'],
    ['running', { activity: 'monitoring' as const }, 'running'],
    ['waiting', {}, 'needs-you'],
    ['review', {}, 'review'],
    ['done', {}, 'done'],
    ['cancelled', {}, 'not-doing'],
    ['failed', {}, 'done'],
  ] as const)('%s %j → %s', (status, extra, expected) => {
    expect(boardColumn(run({ status, ...extra }))).toBe(expected)
  })

  it('a failed run parked by a usage limit is work with an appointment, not an outcome → Queued', () => {
    expect(boardColumn(run({ status: 'failed', autoResumeAt: '2026-10-04T13:00:00.000Z' }))).toBe('queued')
  })
})

describe('groupBoard', () => {
  it('drops archived runs from every column', () => {
    const archived = run({ status: 'running', archived: true })
    const { columns, hiddenHistory } = groupBoard([archived], { now: NOW })
    expect(Object.values(columns).flat()).toEqual([])
    expect(hiddenHistory).toBe(0)
  })

  it('puts every non-archived run in exactly one place (a column or the hidden-history count)', () => {
    const runs = [
      run({ status: 'queued' }),
      run({ status: 'running' }),
      run({ status: 'waiting' }),
      run({ status: 'review' }),
      run({ status: 'done', finishedAt: '2026-10-04T11:00:00.000Z' }),
      run({ status: 'done', finishedAt: '2026-09-01T11:00:00.000Z' }),
      run({ status: 'cancelled', finishedAt: '2026-10-04T11:30:00.000Z' }),
      run({ status: 'failed', autoResumeAt: '2026-10-04T13:00:00.000Z' }),
    ]
    const { columns, hiddenHistory } = groupBoard(runs, { now: NOW })
    const placed = Object.values(columns).flat().map((r) => r.id)
    expect(new Set(placed).size).toBe(placed.length)
    expect(placed.length + hiddenHistory).toBe(runs.length)
  })

  it('Queued: scheduled runs first by soonest resume, then queued runs oldest-first (FIFO)', () => {
    const q1 = run({ status: 'queued', createdAt: '2026-10-04T09:00:00.000Z' })
    const q2 = run({ status: 'queued', createdAt: '2026-10-04T10:00:00.000Z' })
    const late = run({ status: 'failed', autoResumeAt: '2026-10-04T15:00:00.000Z' })
    const soon = run({ status: 'failed', autoResumeAt: '2026-10-04T13:00:00.000Z' })
    const { columns } = groupBoard([q2, late, q1, soon], { now: NOW })
    expect(shape(columns).queued).toEqual([soon.id, late.id, q1.id, q2.id])
  })

  it('a pinned run leads its column, as it leads the task list (sortRuns pinned-first)', () => {
    const q1 = run({ status: 'queued', createdAt: '2026-10-04T09:00:00.000Z' })
    const pinned = run({ status: 'queued', createdAt: '2026-10-04T10:00:00.000Z', pinned: true })
    expect(shape(groupBoard([q1, pinned], { now: NOW }).columns).queued).toEqual([pinned.id, q1.id])
  })

  it('Running: newest first', () => {
    const older = run({ status: 'running', createdAt: '2026-10-04T09:00:00.000Z' })
    const newer = run({ status: 'running', createdAt: '2026-10-04T10:00:00.000Z' })
    expect(shape(groupBoard([older, newer], { now: NOW }).columns).running).toEqual([newer.id, older.id])
  })

  it('Done: ordered by finishedAt, newest first — not by createdAt', () => {
    const createdLateFinishedEarly = run({
      status: 'done', createdAt: '2026-10-04T08:00:00.000Z', finishedAt: '2026-10-04T09:00:00.000Z',
    })
    const createdEarlyFinishedLate = run({
      status: 'failed', createdAt: '2026-10-03T08:00:00.000Z', finishedAt: '2026-10-04T11:00:00.000Z',
    })
    const { columns } = groupBoard([createdLateFinishedEarly, createdEarlyFinishedLate], { now: NOW })
    expect(shape(columns).done).toEqual([createdEarlyFinishedLate.id, createdLateFinishedEarly.id])
  })

  it('hides terminal outcomes finished more than 7 days ago and shows them on request', () => {
    const recent = run({ status: 'done', finishedAt: new Date(NOW - DONE_WINDOW_MS + 60_000).toISOString() })
    const old = run({ status: 'cancelled', finishedAt: new Date(NOW - DONE_WINDOW_MS - 60_000).toISOString() })
    const hidden = groupBoard([recent, old], { now: NOW })
    expect(shape(hidden.columns).done).toEqual([recent.id])
    expect(hidden.hiddenHistory).toBe(1)
    const shown = groupBoard([recent, old], { now: NOW, showOlderHistory: true })
    expect(shape(shown.columns).done).toEqual([recent.id])
    expect(shape(shown.columns)['not-doing']).toEqual([old.id])
    expect(shown.hiddenHistory).toBe(0)
  })

  it('Not doing: a cancelled run with no finishedAt falls back to createdAt for the window', () => {
    const noFinish = run({ status: 'cancelled', createdAt: '2026-10-04T10:00:00.000Z' })
    const { columns, hiddenHistory } = groupBoard([noFinish], { now: NOW })
    expect(shape(columns)['not-doing']).toEqual([noFinish.id])
    expect(hiddenHistory).toBe(0)
  })

  it('Done: an unparseable finishedAt is treated as old (hidden and counted), never crashes', () => {
    const garbage = run({ status: 'done', finishedAt: 'not-a-date' })
    const { columns, hiddenHistory } = groupBoard([garbage], { now: NOW })
    expect(shape(columns).done).toEqual([])
    expect(hiddenHistory).toBe(1)
  })

  it('Done: with older shown, an unparseable finishedAt sorts last, as the oldest', () => {
    const garbage = run({ status: 'done', finishedAt: 'not-a-date' })
    const valid = run({ status: 'done', finishedAt: '2026-10-04T11:00:00.000Z' })
    const { columns } = groupBoard([garbage, valid], { now: NOW, showOlderHistory: true })
    expect(shape(columns).done).toEqual([valid.id, garbage.id])
  })

  it('the window does not apply to active columns (an old queued run stays visible)', () => {
    const ancient = run({ status: 'queued', createdAt: '2026-01-01T00:00:00.000Z' })
    expect(shape(groupBoard([ancient], { now: NOW }).columns).queued).toEqual([ancient.id])
  })
})
