import { TriangleAlertIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getUiState, putUiState } from '@/api/client'
import { queryKeys, useAgentProfiles, useConfig, useRuns } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Segmented } from '@/components/segmented'
import { Button } from '@/components/ui/button'
import { agentSummary } from '@/lib/agent-summary'
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, groupBoard, type BoardColumnId } from '@/lib/board-columns'
import { applyBoardOrder } from '@/lib/board-moves'
import { useActiveProjectId } from '@/lib/project-router'
import { useIsDesktop } from '@/lib/use-desktop'

import { BoardCard } from './board-card'
import { BoardColumn } from './board-column'
import { BoardDnd } from './board-dnd'
import { BoardMoveDialog } from './board-move-dialog'
import { MovableBoardCard } from './movable-board-card'
import { useBoardMoves } from './use-board-moves'
import { useBoardDrop, useBoardOrder } from './use-board-order'

/** How often the card clocks re-read the time. Ages under a minute print in seconds and can lag
 *  by up to this long; minutes and hours stay honest — and the board isn't re-rendered every
 *  second. */
const CLOCK_TICK_MS = 30_000

/** The per-project board is ONE drag area. */
const LANE = 'board'

/**
 * `/board` — the project's tasks as kanban columns (spec `.ai/specs/2026-10-04-kanban-board.md`,
 * phases 1 and 1c).
 *
 * Reads `useRuns()`, the active project's run list that the workspace event stream patches, so
 * the board updates live and can never disagree with the task list beside it. A card moves column
 * only when its run's status changes: dragging one (from `md` up) or its ⋯ menu either re-sorts a
 * column whose order is the user's (Running, Needs you, Review — saved in the project's ui-state),
 * or asks for a confirmed action (accept, finish, cancel, stop resuming, run again), or snaps back
 * with the reason.
 *
 * The five columns always render, even with no tasks — each empty one says "Nothing here", and a
 * hint under the title points at Queued — so a task started while the board is open lands in a
 * column that is already on screen. An error screen replaces the board only when there is no
 * data at all; a failed background refetch keeps the board it already has.
 *
 * Below `md` a segmented switcher scrolls the chosen column into view. It follows taps only, not
 * manual swipes — a deliberate phase-1 simplification.
 */
export function BoardRoute() {
  const runs = useRuns()
  const config = useConfig()
  const profiles = useAgentProfiles()
  const desktop = useIsDesktop()
  const projectId = useActiveProjectId() ?? 'default'
  const [showOlderDone, setShowOlderDone] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [focused, setFocused] = useState<BoardColumnId>('queued')
  const columnRefs = useRef<Partial<Record<BoardColumnId, HTMLElement | null>>>({})
  // Stable per column, so a column's merged ref (scroll target + drop zone) never churns.
  const columnRefSetters = useMemo(
    () =>
      Object.fromEntries(
        BOARD_COLUMNS.map((id) => [id, (node: HTMLElement | null) => void (columnRefs.current[id] = node)]),
      ) as Record<BoardColumnId, (node: HTMLElement | null) => void>,
    [],
  )

  const order = useBoardOrder({ queryKey: queryKeys.uiState, read: getUiState, write: putUiState })
  const moves = useBoardMoves(useCallback(() => projectId, [projectId]))

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const view = useMemo(() => {
    if (!runs.data) return undefined
    const board = groupBoard(runs.data, { now, showOlderDone })
    return {
      columns: applyBoardOrder(board.columns, order.order),
      hiddenDone: board.hiddenDone,
      hasTasks: runs.data.some((run) => !run.archived),
    }
  }, [runs.data, now, showOlderDone, order.order])

  const columns = view?.columns
  // A confirmed card now drawn in another column has landed: announce it, give focus back.
  const { observe } = moves
  useEffect(() => {
    if (columns) observe(projectId, columns)
  }, [columns, observe, projectId])
  const drop = useBoardDrop({
    columns: columns ?? { queued: [], running: [], 'needs-you': [], review: [], done: [] },
    order,
    moves,
  })
  const agentLine = { defaultRunner: config.data?.defaultRunner, profiles: profiles.data?.profiles }

  // Only when there is nothing to show: TanStack Query keeps the cached runs and sets `isError`
  // on a failed background refetch, and that must not replace a working board.
  if (runs.isError && !runs.data) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        title="Couldn't load tasks"
        subtitle={runs.error instanceof Error ? runs.error.message : undefined}
      />
    )
  }
  if (!view || !columns) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading board…
      </div>
    )
  }

  const focus = (id: BoardColumnId) => {
    setFocused(id)
    columnRefs.current[id]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  const doneAction =
    view.hiddenDone > 0 || showOlderDone ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[12px]"
        onClick={() => setShowOlderDone((value) => !value)}
      >
        {showOlderDone ? 'Hide older' : `Show ${view.hiddenDone} older`}
      </Button>
    ) : undefined

  return (
    <div data-slot="board" className="flex h-full min-h-0 flex-col">
      <header className="hidden items-center justify-between gap-3 px-4 pt-4 md:flex md:px-6">
        <h1 className="text-sm font-semibold text-foreground">Board</h1>
      </header>
      {view.hasTasks ? null : (
        <p data-slot="board-empty-hint" className="px-4 pt-3 text-[13px] text-soft-foreground md:px-6 md:pt-1">
          No tasks yet — start one and it lands in Queued.
        </p>
      )}
      <div className="px-4 pt-3 md:hidden">
        <Segmented
          slot="board-switcher"
          label="Jump to column"
          value={focused}
          full
          // A re-tap scrolls to the column again after a manual swipe moved away from it. Segmented
          // calls this "release"; here it is a repeat jump.
          allowRelease
          options={BOARD_COLUMNS.map((id) => ({
            value: id,
            label: BOARD_COLUMN_LABELS[id],
          }))}
          onChange={focus}
        />
      </div>
      <BoardDnd
        enabled={desktop}
        onDrop={drop.onDrop}
        judge={drop.judge}
        renderOverlay={(card) => (
          <BoardCard run={card.run} now={now} agent={agentSummary(card.run, agentLine)?.text} overlay />
        )}
      >
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 items-start gap-3 overflow-x-auto p-4 md:snap-none md:scroll-px-6 md:px-6">
          {BOARD_COLUMNS.map((id) => (
            <BoardColumn
              key={id}
              id={id}
              laneId={LANE}
              runs={columns[id]}
              action={id === 'done' ? doneAction : undefined}
              ref={columnRefSetters[id]}
              renderCard={(run, handle, column) => (
                <MovableBoardCard
                  run={run}
                  column={column}
                  handle={handle}
                  now={now}
                  moves={moves}
                  agentLine={agentLine}
                />
              )}
            />
          ))}
        </div>
      </BoardDnd>
      <BoardMoveDialog moves={moves} />
    </div>
  )
}