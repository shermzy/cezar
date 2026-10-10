import type { RunRecord } from '@open-mercato/cezar-api-client'

import { deriveAttention, type AttentionInput } from '@/lib/attention'
import { sortRuns, type SortableRun } from '@/lib/task-groups'

/**
 * The Board's columns, left to right.
 * The Backlog column arrives in phase 3; until then the board starts at Queued.
 */
export const BOARD_COLUMNS = ['queued', 'running', 'needs-you', 'review', 'not-doing', 'done'] as const
export type BoardColumnId = (typeof BOARD_COLUMNS)[number]

export const BOARD_COLUMN_LABELS: Record<BoardColumnId, string> = {
  queued: 'Queued',
  running: 'Running',
  'needs-you': 'Needs you',
  review: 'Review',
  'not-doing': 'Not doing',
  done: 'Done',
}

/** Terminal outcomes show the last week by default — history only grows. */
export const DONE_WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * Which column a run sits in. First match wins.
 *
 * Driven by `deriveAttention` where attention decides (the `permission` rung — always false
 * today, wired for when cezar reports pending permissions) and by `status` otherwise. A `failed`
 * run with `autoResumeAt` is parked by a provider usage limit: it is work with an appointment,
 * so it waits in Queued beside the queue rather than reading as an outcome in Not doing — the same
 * call `task-groups.ts` makes with its `scheduled` weight.
 */
export function boardColumn(run: AttentionInput): BoardColumnId {
  if (deriveAttention(run).bucket === 'permission') return 'needs-you'
  switch (run.status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'waiting':
      return 'needs-you'
    case 'review':
      return 'review'
    case 'failed':
      return run.autoResumeAt ? 'queued' : 'done'
    case 'cancelled':
      return 'not-doing'
    case 'done':
      return 'done'
    default:
      return 'done'
  }
}

/**
 * What `groupBoard` reads: `sortRuns`'s inputs, `boardColumn`'s, and the Done window's end time.
 * A slim cross-project index row (`RunIndexEntry`) satisfies it as well as a full record, which is
 * what lets the all-projects board group with this very function (spec § Phase 1b).
 */
export type BoardRunInput = SortableRun & AttentionInput & Pick<RunRecord, 'finishedAt'>

export interface BoardGroups<T extends BoardRunInput> {
  columns: Record<BoardColumnId, T[]>
  /** Terminal runs outside the window, for the "Show older outcomes" toggle. */
  hiddenHistory: number
}

/**
 * The whole board, ready to render.
 *
 * Ordering is `sortRuns(runs, 'active')` — the task list's own rule, so the two surfaces never
 * disagree about "what happens next": archived runs dropped, pinned first, scheduled by soonest
 * resume, queued FIFO, everything else newest first. Terminal outcomes are re-sorted by
 * `finishedAt`, because history reads by when things ended, not when they were asked for.
 */
export function groupBoard<T extends BoardRunInput>(
  runs: readonly T[],
  { now = Date.now(), showOlderHistory = false }: { now?: number; showOlderHistory?: boolean } = {},
): BoardGroups<T> {
  const columns = Object.fromEntries(BOARD_COLUMNS.map((id) => [id, [] as T[]])) as Record<BoardColumnId, T[]>
  let hiddenHistory = 0
  for (const run of sortRuns(runs, 'active')) {
    const column = boardColumn(run)
    if ((column === 'done' || column === 'not-doing') && !showOlderHistory && !endedWithin(run, now, DONE_WINDOW_MS)) {
      hiddenHistory += 1
      continue
    }
    columns[column].push(run)
  }
  // Two unparseable stamps subtract to NaN, which `sort` treats as equal — they keep `sortRuns` order.
  columns.done.sort((a, b) => endedMs(b) - endedMs(a))
  columns['not-doing'].sort((a, b) => endedMs(b) - endedMs(a))
  return { columns, hiddenHistory }
}

/**
 * When a run ended, in epoch ms — `finishedAt`, or `createdAt` for a run that never recorded one.
 * An unparseable timestamp is `-Infinity`: the oldest possible end. The window check then hides
 * it and the Done sort puts it last, so one parsing rule serves both and garbage never reads as
 * "just now".
 */
function endedMs(run: Pick<RunRecord, 'finishedAt' | 'createdAt'>): number {
  const ms = Date.parse(run.finishedAt ?? run.createdAt)
  return Number.isNaN(ms) ? -Infinity : ms
}

function endedWithin(run: Pick<RunRecord, 'finishedAt' | 'createdAt'>, now: number, windowMs: number): boolean {
  return now - endedMs(run) <= windowMs
}
