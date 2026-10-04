import { TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useRuns } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Segmented } from '@/components/segmented'
import { Button } from '@/components/ui/button'
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, groupBoard, type BoardColumnId } from '@/lib/board-columns'

import { BoardColumn } from './board-column'

/** How often the card clocks re-read the time. Ages under a minute print in seconds and can lag
 *  by up to this long; minutes and hours stay honest — and the board isn't re-rendered every
 *  second. */
const CLOCK_TICK_MS = 30_000

/**
 * `/board` — the project's tasks as kanban columns (spec `.ai/specs/2026-10-04-kanban-board.md`,
 * phase 1). Read-only: runs move between columns because their status changes, never because
 * someone dragged them — the statuses belong to the agents.
 *
 * Reads `useRuns()`, the active project's run list that the workspace event stream patches, so
 * the board updates live and can never disagree with the task list beside it.
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
  const [showOlderDone, setShowOlderDone] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [focused, setFocused] = useState<BoardColumnId>('queued')
  const columnRefs = useRef<Partial<Record<BoardColumnId, HTMLElement | null>>>({})

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const view = useMemo(
    () =>
      runs.data
        ? {
            board: groupBoard(runs.data, { now, showOlderDone }),
            hasTasks: runs.data.some((run) => !run.archived),
          }
        : undefined,
    [runs.data, now, showOlderDone],
  )

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
  if (!view) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading board…
      </div>
    )
  }
  const { board, hasTasks } = view

  const focus = (id: BoardColumnId) => {
    setFocused(id)
    columnRefs.current[id]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  const doneAction =
    board.hiddenDone > 0 || showOlderDone ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[12px]"
        onClick={() => setShowOlderDone((value) => !value)}
      >
        {showOlderDone ? 'Hide older' : `Show ${board.hiddenDone} older`}
      </Button>
    ) : undefined

  return (
    <div data-slot="board" className="flex h-full min-h-0 flex-col">
      <header className="hidden items-center justify-between gap-3 px-4 pt-4 md:flex md:px-6">
        <h1 className="text-sm font-semibold text-foreground">Board</h1>
      </header>
      {hasTasks ? null : (
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
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 items-start gap-3 overflow-x-auto p-4 md:snap-none md:scroll-px-6 md:px-6">
        {BOARD_COLUMNS.map((id) => (
          <BoardColumn
            key={id}
            id={id}
            runs={board.columns[id]}
            now={now}
            action={id === 'done' ? doneAction : undefined}
            ref={(node) => {
              columnRefs.current[id] = node
            }}
          />
        ))}
      </div>
    </div>
  )
}
