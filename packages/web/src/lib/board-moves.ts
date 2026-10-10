import type { RunRecord } from '@open-mercato/cezar-api-client'

import type { BoardColumnId } from '@/lib/board-columns'

/**
 * What a drop on the Board means (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Moving
 * cards). Pure on purpose — `board-moves.test.ts` is the contract: the whole from/to table, the
 * scheduled-run case and every refusal's wording.
 *
 * A card never moves because it was dropped. A reorder only re-sorts its own column; an action is
 * asked for in a dialog and the card moves when the run's REAL status changes over the stream.
 */

/** The columns a user may order by hand. Queued follows cezar's real FIFO start order; terminal
 *  history is ordered by when tasks ended, so a manual order there would mislead. */
export const REORDERABLE_COLUMNS = ['running', 'needs-you', 'review'] as const
export type ReorderableColumn = (typeof REORDERABLE_COLUMNS)[number]

export function isReorderable(column: BoardColumnId): column is ReorderableColumn {
  return (REORDERABLE_COLUMNS as readonly string[]).includes(column)
}

/**
 * The confirmed key moves, each one an existing route:
 * - `accept` — Review → Done, `POST /runs/:id/finish` on a run resting at review;
 * - `finish` — Needs you → Done, `POST /runs/:id/finish` on an open session;
 * - `cancel` — Running/Queued/Needs you → Not doing, `POST /runs/:id/cancel`;
 * - `stop-resume` — a SCHEDULED card (failed, parked by a usage limit) → Done,
 *   `DELETE /runs/:id/auto-resume`: there is no queue entry or session for the cancel route to stop;
 * - `rerun` — Done/Not doing → Queued, a new task through `POST /runs` (`rerunBody`).
 */
export type BoardAction = 'accept' | 'finish' | 'cancel' | 'stop-resume' | 'rerun'

export type MoveIntent =
  | { kind: 'reorder'; column: ReorderableColumn }
  | { kind: 'action'; action: BoardAction }
  | { kind: 'refuse'; reason: string }

/** What a move reads of the run: its status, and whether a usage-limit resume is booked. */
export type MoveRun = Pick<RunRecord, 'status' | 'autoResumeAt'>

const AGENT_OWNS_REVIEW = 'The agent decides when a task needs review.'
const AGENT_OWNS_NEEDS_YOU = 'The agent decides when a task needs you.'
const QUEUE_IS_FIFO = 'Queued tasks start in the order they were queued.'
const HISTORY_IS_ORDERED = 'Terminal outcomes are ordered by when tasks ended.'
const QUEUE_STARTS_ITSELF = 'Queued tasks start on their own when a slot frees up.'
const RERUN_FROM_QUEUED = 'To run this task again, drop it on Queued.'
const CANCEL_TO_NOT_DOING = 'Drop active work on Not doing to cancel it.'
const NOT_DOING_NEEDS_ACTIVE_RUN = 'Only queued or active work can be cancelled.'
const NO_WAY_BACK = "A task that has started can't go back to the queue."
const REPLY_ON_ITS_PAGE = 'Answer it on its page to set it working again.'

/**
 * `from` → `to` for this run: a reorder, a confirmed action, or a refusal with the sentence the
 * toast shows. `from` is the column the card is drawn in (`boardColumn(run)`).
 */
export function moveIntent(from: BoardColumnId, to: BoardColumnId, run: MoveRun): MoveIntent {
  if (from === to) {
    if (isReorderable(from)) return { kind: 'reorder', column: from }
    return refuse(from === 'queued' ? QUEUE_IS_FIFO : HISTORY_IS_ORDERED)
  }
  if (from === 'done' || from === 'not-doing') {
    return to === 'queued' ? action('rerun') : refuse(RERUN_FROM_QUEUED)
  }
  switch (to) {
    case 'done':
      if (from === 'review') return action('accept')
      if (from === 'needs-you') return action('finish')
      return refuse(CANCEL_TO_NOT_DOING)
    case 'not-doing':
      if (from === 'queued' && run.status === 'failed' && run.autoResumeAt) return action('stop-resume')
      if (from === 'queued' || from === 'running' || from === 'needs-you') return action('cancel')
      return refuse(NOT_DOING_NEEDS_ACTIVE_RUN)
    case 'queued':
      return refuse(NO_WAY_BACK)
    case 'running':
      return refuse(from === 'queued' ? QUEUE_STARTS_ITSELF : REPLY_ON_ITS_PAGE)
    case 'needs-you':
      return refuse(AGENT_OWNS_NEEDS_YOU)
    case 'review':
      return refuse(AGENT_OWNS_REVIEW)
  }
}

/** The actions a card's ⋯ menu offers: exactly the drops that would be actions from its column. */
export function cardActions(from: BoardColumnId, run: MoveRun): BoardAction[] {
  const actions: BoardAction[] = []
  for (const to of ['done', 'not-doing', 'queued'] as const) {
    const intent = moveIntent(from, to, run)
    if (intent.kind === 'action') actions.push(intent.action)
  }
  return actions
}

function action(name: BoardAction): MoveIntent {
  return { kind: 'action', action: name }
}

function refuse(reason: string): MoveIntent {
  return { kind: 'refuse', reason }
}

/**
 * A column's display order with the user's saved order applied: runs NOT in the saved list first,
 * in their default order — so a run that just arrived surfaces at the top instead of under a long
 * saved list — then the listed runs in saved order. Stale ids (runs that left the column) are
 * ignored, and a duplicated id counts once, at its first place.
 */
export function applyManualOrder<T extends { id: string }>(runs: readonly T[], ids: readonly string[] | undefined): T[] {
  if (!ids || ids.length === 0) return [...runs]
  const rank = new Map<string, number>()
  for (const id of ids) if (!rank.has(id)) rank.set(id, rank.size)
  const fresh = runs.filter((run) => !rank.has(run.id))
  const placed = runs.filter((run) => rank.has(run.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...fresh, ...placed]
}

/** The most ids one column's saved order keeps — the server's bound (`server.ts` `uiStateSchema`). */
export const BOARD_ORDER_LIMIT = 500

/** `board.order` in the per-project ui-state: one id list per reorderable column. */
export type BoardOrder = Partial<Record<ReorderableColumn, string[]>>

/** The per-project `board` ui-state object. Open: a newer cockpit's keys must survive this one. */
export interface BoardPrefs {
  order?: BoardOrder
  [key: string]: unknown
}

/**
 * `readUiState` hands the file back unvalidated (one bad pref must not discard the bag), so a
 * hand-edited `board` can hold anything. These read it defensively: anything but an object is no
 * object, and anything but a list of strings is no saved order.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function savedIds(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : undefined
}

/**
 * The WHOLE `board` object to send after reordering one column. `PUT /ui-state` merges shallowly,
 * so a body carrying only this column would erase the other columns' orders — and any `board` key
 * a newer cockpit wrote. Capped at `BOARD_ORDER_LIMIT`, keeping the top of the column. A corrupt
 * `board` or `order` is replaced, its other keys kept.
 */
export function withColumnOrder(board: unknown, column: ReorderableColumn, ids: readonly string[]): BoardPrefs {
  const prefs = isRecord(board) ? board : {}
  const order = (isRecord(prefs.order) ? prefs.order : {}) as BoardOrder
  return { ...prefs, order: { ...order, [column]: ids.slice(0, BOARD_ORDER_LIMIT) } }
}

/** Every column of a board area with the saved order applied to the three reorderable ones. The
 *  saved order is read as stored — see `savedIds`. */
export function applyBoardOrder<T extends { id: string }>(
  columns: Record<BoardColumnId, T[]>,
  order: unknown,
): Record<BoardColumnId, T[]> {
  const saved = isRecord(order) ? order : {}
  return {
    ...columns,
    running: applyManualOrder(columns.running, savedIds(saved.running)),
    'needs-you': applyManualOrder(columns['needs-you'], savedIds(saved['needs-you'])),
    review: applyManualOrder(columns.review, savedIds(saved.review)),
  }
}
