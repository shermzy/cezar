import { describe, expect, it } from 'vitest'

import { DONE_WINDOW_MS } from '@/lib/board-columns'
import { groupLanes, type Lane, type LaneRunInput } from '@/lib/board-lanes'

/**
 * Failure modes of the all-projects board's lanes (spec `.ai/specs/2026-10-04-kanban-board.md`
 * § Phase 1b → Testing), written before `board-lanes.ts`. Each `describe` is one listed mode.
 */

const NOW = Date.parse('2026-10-04T12:00:00.000Z')
const OPENED = '2026-09-01T00:00:00.000Z'
const WITHIN_WINDOW = new Date(NOW - DONE_WINDOW_MS + 60_000).toISOString()
const OUTSIDE_WINDOW = new Date(NOW - DONE_WINDOW_MS - 60_000).toISOString()

type TestRun = LaneRunInput & { id: string }
type TestProject = { id: string; lastOpenedAt: string; unregistered?: boolean }

let seq = 0

function run(projectId: string, over: Partial<TestRun> = {}): TestRun {
  seq += 1
  return {
    projectId,
    id: `r${seq}`,
    status: 'done',
    createdAt: '2026-10-04T10:00:00.000Z',
    finishedAt: '2026-10-04T11:00:00.000Z',
    archived: false,
    ...over,
  }
}

function project(id: string, lastOpenedAt = OPENED, unregistered?: true): TestProject {
  return unregistered ? { id, lastOpenedAt, unregistered } : { id, lastOpenedAt }
}

const laneIds = (lanes: Lane<TestProject, TestRun>[]) => lanes.map((lane) => lane.project.id)

const kinds = (lanes: Lane<TestProject, TestRun>[]) =>
  Object.fromEntries(lanes.map((lane) => [lane.project.id, lane.kind]))

const cardIds = (lane: Lane<TestProject, TestRun> | undefined) =>
  lane === undefined ? [] : Object.values(lane.columns).flat().map((card) => card.id)

describe('lane order is the sidebar order', () => {
  const projects = [
    project('placed-b', '2026-09-01T00:00:00.000Z'),
    project('placed-a', '2026-09-02T00:00:00.000Z'),
    project('unlisted-old', '2026-09-10T00:00:00.000Z'),
    project('unlisted-new', '2026-09-20T00:00:00.000Z'),
    // No `lastOpenedAt` — the recency sort alone would bury it last.
    project('boot', '', true),
  ]

  it('puts the unregistered boot folder first, unlisted projects next by lastOpenedAt, then the hand-placed ones in their stored order', () => {
    // The stored order runs AGAINST recency (placed-b before placed-a), so a lane order that
    // fell back to lastOpenedAt alone would fail here.
    const lanes = groupLanes(projects, ['placed-b', 'placed-a'], [], { now: NOW })
    expect(laneIds(lanes)).toEqual(['boot', 'unlisted-new', 'unlisted-old', 'placed-b', 'placed-a'])
  })

  it('with nothing stored, is most-recently-opened first — still behind the unregistered boot folder', () => {
    const lanes = groupLanes(projects, [], [], { now: NOW })
    expect(laneIds(lanes)).toEqual(['boot', 'unlisted-new', 'unlisted-old', 'placed-a', 'placed-b'])
  })
})

describe('active / done-only / quiet, at the 7-day Done window', () => {
  it.each<[string, Partial<TestRun>]>([
    ['queued', { status: 'queued' }],
    ['running', { status: 'running' }],
    ['waiting', { status: 'waiting' }],
    ['review', { status: 'review' }],
    ['scheduled', { status: 'failed', autoResumeAt: '2026-10-04T13:00:00.000Z' }],
  ])('one %s run makes a lane active', (_label, over) => {
    const [lane] = groupLanes([project('p')], [], [run('p', over)], { now: NOW })
    expect(lane?.kind).toBe('active')
  })

  it('an active column wins over Done, whatever Done holds', () => {
    const runs = [run('p', { status: 'queued' }), run('p', { status: 'done', finishedAt: WITHIN_WINDOW })]
    expect(groupLanes([project('p')], [], runs, { now: NOW })[0]?.kind).toBe('active')
  })

  it('a Done run just inside the window is done-only; just outside it is quiet and counted as hidden', () => {
    const lanes = groupLanes(
      [project('inside'), project('outside'), project('empty')],
      [],
      [
        run('inside', { status: 'done', finishedAt: WITHIN_WINDOW }),
        run('outside', { status: 'failed', finishedAt: OUTSIDE_WINDOW }),
      ],
      { now: NOW },
    )
    expect(kinds(lanes)).toEqual({ inside: 'done-only', outside: 'quiet', empty: 'quiet' })
    expect(lanes.map((lane) => lane.hiddenDone)).toEqual([0, 1, 0])
  })

  it('"Show older done" moves the line: an old Done run is visible, so its lane is done-only', () => {
    const [lane] = groupLanes([project('p')], [], [run('p', { status: 'done', finishedAt: OUTSIDE_WINDOW })], {
      now: NOW,
      showOlderDone: true,
    })
    expect(lane?.kind).toBe('done-only')
    expect(lane?.hiddenDone).toBe(0)
  })
})

describe('a truncated lane is never quiet', () => {
  it('stays reachable as done-only when nothing in it is visible — its "newest N" notice must not hide', () => {
    const lanes = groupLanes(
      [project('capped'), project('capped-empty'), project('small')],
      [],
      [run('capped', { status: 'done', finishedAt: OUTSIDE_WINDOW })],
      { now: NOW, truncatedIds: ['capped', 'capped-empty'] },
    )
    expect(lanes.map((lane) => [lane.project.id, lane.kind, lane.truncated])).toEqual([
      ['capped', 'done-only', true],
      ['capped-empty', 'done-only', true],
      ['small', 'quiet', false],
    ])
  })

  it('is still active when it has work in flight', () => {
    const [lane] = groupLanes([project('capped')], [], [run('capped', { status: 'running' })], {
      now: NOW,
      truncatedIds: ['capped'],
    })
    expect(lane?.kind).toBe('active')
    expect(lane?.truncated).toBe(true)
  })
})

describe('runs of unknown projects', () => {
  it('are dropped — never shown in another lane, never given a lane of their own', () => {
    const known = run('known', { status: 'running' })
    const lanes = groupLanes([project('known')], [], [known, run('removed', { status: 'running' })], { now: NOW })
    expect(laneIds(lanes)).toEqual(['known'])
    expect(cardIds(lanes[0])).toEqual([known.id])
  })
})

describe('archived runs', () => {
  it('are excluded from every column and from the hidden count, so an archived-only project is quiet', () => {
    const [lane] = groupLanes(
      [project('p')],
      [],
      [run('p', { status: 'running', archived: true }), run('p', { status: 'done', archived: true, finishedAt: OUTSIDE_WINDOW })],
      { now: NOW },
    )
    expect(cardIds(lane)).toEqual([])
    expect(lane?.hiddenDone).toBe(0)
    expect(lane?.kind).toBe('quiet')
  })
})

describe('an empty registry', () => {
  it('has no lanes, even when runs arrive', () => {
    expect(groupLanes([], [], [run('orphan', { status: 'running' })], { now: NOW })).toEqual([])
  })
})

describe("each lane's Queued column", () => {
  it('is ordered on its own: scheduled runs first by soonest resume, then queued runs oldest-first', () => {
    const make = (projectId: string) => ({
      q1: run(projectId, { status: 'queued', createdAt: '2026-10-04T09:00:00.000Z' }),
      q2: run(projectId, { status: 'queued', createdAt: '2026-10-04T10:00:00.000Z' }),
      late: run(projectId, { status: 'failed', autoResumeAt: '2026-10-04T15:00:00.000Z' }),
      soon: run(projectId, { status: 'failed', autoResumeAt: '2026-10-04T13:00:00.000Z' }),
    })
    const a = make('a')
    const b = make('b')
    // Interleaved across projects and out of order within each, so neither input order nor a
    // cross-project sort can produce the expected columns by accident.
    const runs = [b.q2, a.late, b.q1, a.q2, b.soon, a.q1, a.soon, b.late]
    const lanes = groupLanes([project('a'), project('b')], ['a', 'b'], runs, { now: NOW })
    const queued = (id: string) => lanes.find((lane) => lane.project.id === id)?.columns.queued.map((card) => card.id)
    expect(queued('a')).toEqual([a.soon.id, a.late.id, a.q1.id, a.q2.id])
    expect(queued('b')).toEqual([b.soon.id, b.late.id, b.q1.id, b.q2.id])
  })
})
