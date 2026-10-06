import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { arrayMove } from '@dnd-kit/sortable'
import { useCallback } from 'react'

import type { UiState } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import type { BoardColumnId } from '@/lib/board-columns'
import { moveIntent, withColumnOrder, type MoveIntent, type MoveRun, type ReorderableColumn } from '@/lib/board-moves'

import type { BoardCardRun } from './board-card'
import type { DndCard, DropTarget } from './board-dnd'
import type { BoardMoves } from './use-board-moves'

/**
 * The ui-state cache key of a project named EXPLICITLY — `[projectId, 'ui-state']`, the very key
 * `queryKeys.uiState` builds inside that project's scope, so the two boards share one cache entry.
 * The boot project mounts unscoped, so its key is `default`-led (as `useProjectRuns` aliases it).
 */
export function projectUiStateKey(projectId: string, bootId: string | null) {
  return [projectId === bootId ? 'default' : projectId, 'ui-state'] as const
}

/**
 * One project's saved Board order (`board.order` in its `.ai/cezar/ui-state.json`, spec
 * § Phase 1c): read through whichever ui-state query the caller names, written whole.
 *
 * The write patches the cache first, so the column re-sorts at once, then adopts the server's
 * merged answer; a failure is a danger toast and a refetch of the truth. Reordering waits for
 * `ready`: an order composed from an empty cache would erase the other columns' saved orders.
 */
export function useBoardOrder({
  queryKey,
  read,
  write,
  enabled = true,
}: {
  queryKey: QueryKey
  read: (opts: { signal: AbortSignal }) => Promise<UiState>
  write: (patch: UiState) => Promise<UiState>
  enabled?: boolean
}) {
  const queryClient = useQueryClient()
  const state = useQuery({ queryKey, queryFn: ({ signal }) => read({ signal }), enabled })
  const board = state.data?.board
  const save = useCallback(
    (column: ReorderableColumn, ids: string[]) => {
      const next = withColumnOrder(board, column, ids)
      queryClient.setQueryData<UiState>(queryKey, (previous) => ({ ...previous, board: next }))
      write({ board: next })
        .then((merged) => queryClient.setQueryData(queryKey, merged))
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          void queryClient.invalidateQueries({ queryKey })
        })
    },
    [board, queryClient, queryKey, write],
  )
  return { order: board?.order, ready: state.data !== undefined, save }
}

export type BoardOrderHandle = ReturnType<typeof useBoardOrder>

/**
 * What a drop on one board area does: refuse (a toast, the card snaps back), reorder its column
 * (saved to ui-state), or ask for a confirmed action (`moves.request` opens the dialog). `judge`
 * is the same question for the column highlight while dragging.
 */
export function useBoardDrop<T extends BoardCardRun & MoveRun>({
  columns,
  order,
  moves,
}: {
  /** The area's columns as displayed — the manual order already applied. */
  columns: Record<BoardColumnId, readonly T[]>
  order: BoardOrderHandle
  moves: BoardMoves
}) {
  const intentFor = useCallback(
    (card: DndCard<T>, target: DropTarget): MoveIntent => {
      const intent = moveIntent(card.column, target.column, card.run)
      if (intent.kind === 'reorder' && !order.ready) return { kind: 'refuse', reason: 'The saved order is still loading.' }
      return intent
    },
    [order.ready],
  )

  const judge = useCallback((card: DndCard<T>, target: DropTarget) => intentFor(card, target).kind !== 'refuse', [intentFor])

  const onDrop = useCallback(
    (card: DndCard<T>, target: DropTarget) => {
      // Put back on itself: nothing happened, so nothing is said.
      if (target.overRunId === card.run.id) return
      const intent = intentFor(card, target)
      if (intent.kind === 'refuse') {
        // Released over its own (unsortable) column's empty space — a lift and a put-back, too.
        if (target.column === card.column && target.overRunId === undefined) return
        toast(intent.reason)
        return
      }
      if (intent.kind === 'action') {
        void moves.request(card.run, intent.action)
        return
      }
      const ids = columns[intent.column].map((run) => run.id)
      const from = ids.indexOf(card.run.id)
      // Over the column's empty space: to the bottom.
      const to = target.overRunId === undefined ? ids.length - 1 : ids.indexOf(target.overRunId)
      if (from < 0 || to < 0 || from === to) return
      order.save(intent.column, arrayMove(ids, from, to))
    },
    [columns, intentFor, moves, order],
  )

  return { judge, onDrop }
}