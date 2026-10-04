import type { ReactNode, Ref } from 'react'

import { BOARD_COLUMN_LABELS, type BoardColumnId } from '@/lib/board-columns'

import { BoardCard, type BoardCardRun } from './board-card'

/**
 * One Board column: a labelled region, so a screen reader hears "Running, 3 tasks" and can
 * jump between columns like any other landmark. `action` sits in the header beside the count
 * (Done's "Show older" toggle, spec § UI/UX).
 *
 * Width: below `md` a column is most of the scroller's width (one column per swipe, snapped);
 * from `md` up the columns share the row and never shrink under 180 px — narrow enough that all
 * five stay on screen down to a ~1280 px laptop beside the sidebar.
 */
export function BoardColumn<T extends BoardCardRun>({
  id,
  runs,
  now,
  action,
  ref,
}: {
  id: BoardColumnId
  runs: readonly T[]
  now: number
  action?: ReactNode
  ref?: Ref<HTMLElement>
}) {
  const label = BOARD_COLUMN_LABELS[id]
  return (
    <section
      ref={ref}
      data-slot="board-column"
      data-column={id}
      aria-label={`${label}, ${runs.length} ${runs.length === 1 ? 'task' : 'tasks'}`}
      className="flex shrink-0 basis-[85%] snap-start flex-col gap-2 rounded-lg bg-muted p-2 md:min-w-[180px] md:flex-1 md:basis-0"
    >
      <header className="flex items-center justify-between gap-2 px-1 text-[12px] font-semibold text-soft-foreground">
        <h2>{label}</h2>
        <span className="flex items-center gap-1">
          {action}
          <span data-slot="board-column-count">{runs.length}</span>
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {runs.length === 0 ? (
          <p className="px-1 py-3 text-[12px] text-soft-foreground">Nothing here</p>
        ) : (
          runs.map((run) => <BoardCard key={run.id} run={run} now={now} />)
        )}
      </div>
    </section>
  )
}
