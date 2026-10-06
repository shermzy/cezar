import { useCallback, type ReactNode, type Ref } from 'react'

import { BOARD_COLUMN_LABELS, type BoardColumnId } from '@/lib/board-columns'
import { cn } from '@/lib/utils'

import type { BoardCardRun } from './board-card'
import { ColumnCards, useDropColumn } from './board-dnd'

/**
 * One Board column: a labelled region, so a screen reader hears "Running, 3 tasks" and can
 * jump between columns like any other landmark. `action` sits in the header beside the count
 * (Done's "Show older" toggle, spec § UI/UX).
 *
 * The whole column is a drop zone (`useDropColumn`); while a card is dragged over it the column
 * says whether the drop would do something (`data-drop="valid|invalid"`). Its cards come through
 * `renderCard`, which gets each card's drag handle (spec § Phase 1c).
 *
 * Width: below `md` a column is most of the scroller's width (one column per swipe, snapped);
 * from `md` up the columns share the row and never shrink under 180 px — narrow enough that all
 * five stay on screen down to a ~1280 px laptop beside the sidebar.
 */
export function BoardColumn<T extends BoardCardRun>({
  id,
  laneId,
  runs,
  action,
  ref,
  renderCard,
}: {
  id: BoardColumnId
  /** The drag area this column belongs to — the per-project board is one area. */
  laneId: string
  runs: readonly T[]
  action?: ReactNode
  ref?: Ref<HTMLElement>
  renderCard: (run: T, handle: ReactNode, column: BoardColumnId) => ReactNode
}) {
  const label = BOARD_COLUMN_LABELS[id]
  const drop = useDropColumn(laneId, id)
  // One stable callback for both refs: a fresh one per render would detach and re-attach the
  // drop zone on every render while a drag is measuring it.
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      drop.ref(node)
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [drop.ref, ref],
  )
  return (
    <section
      ref={setRef}
      data-slot="board-column"
      data-column={id}
      data-drop={drop.dropState}
      aria-label={`${label}, ${runs.length} ${runs.length === 1 ? 'task' : 'tasks'}`}
      className={cn(
        'flex shrink-0 basis-[85%] snap-start flex-col gap-2 rounded-lg bg-muted p-2 transition-shadow md:min-w-[180px] md:flex-1 md:basis-0',
        drop.dropState === 'valid' && 'ring-2 ring-ring/60',
        drop.dropState === 'invalid' && 'ring-1 ring-border',
      )}
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
          <ColumnCards laneId={laneId} column={id} runs={runs} renderCard={renderCard} />
        )}
      </div>
    </section>
  )
}