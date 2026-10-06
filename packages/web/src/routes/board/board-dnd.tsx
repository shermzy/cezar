import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
} from '@dnd-kit/core'
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon } from 'lucide-react'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

import { BOARD_COLUMN_LABELS, type BoardColumnId } from '@/lib/board-columns'
import { isReorderable } from '@/lib/board-moves'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'

import type { BoardCardRun } from './board-card'

/**
 * The Board's drag and drop (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Moving
 * cards), configured like the sidebar's project groups (`components/project-groups.tsx`): a 4 px
 * pointer distance, the keyboard sensor with `sortableKeyboardCoordinates` (Space lifts, arrows
 * move, Space drops), and announcements in words.
 *
 * - A card is dragged by its HANDLE only — a real `<button>` beside the card's link, never the
 *   link itself, so a drag never ends in a navigation.
 * - The card that follows the pointer is a `DragOverlay` copy; the card itself stays where it is.
 *   Nothing moves on a drop: a reorder re-sorts its own column, an action opens the confirm
 *   dialog, a refusal snaps back. The route decides which (`onDrop`).
 * - Each board area (the per-project board, or ONE All-boards lane) is its own context, so a card
 *   can never be dropped into another project's lane.
 * - Dragging is off below `md` (`enabled`); the card's ⋯ menu covers the same actions there.
 */

/** One draggable card: the lane and column it is drawn in, and its run. */
export interface DndCard<T extends BoardCardRun = BoardCardRun> {
  laneId: string
  column: BoardColumnId
  run: T
}

/** Where a card was dropped: the column under the pointer, and the card it landed on (if any). */
export interface DropTarget {
  laneId: string
  column: BoardColumnId
  overRunId?: string
}

type CardData = { type: 'card'; card: DndCard }
type ColumnData = { type: 'column'; laneId: string; column: BoardColumnId }

const cardDragId = (laneId: string, runId: string) => `card:${laneId}:${runId}`
const columnDropId = (laneId: string, column: BoardColumnId) => `column:${laneId}:${column}`

function cardOf(data: unknown): DndCard | undefined {
  const value = data as Partial<CardData> | undefined
  return value?.type === 'card' ? value.card : undefined
}

function targetOf(data: unknown): DropTarget | undefined {
  const value = data as Partial<CardData> | Partial<ColumnData> | undefined
  if (value?.type === 'card' && 'card' in value && value.card) {
    return { laneId: value.card.laneId, column: value.card.column, overRunId: value.card.run.id }
  }
  if (value?.type === 'column' && 'laneId' in value && value.laneId !== undefined && value.column !== undefined) {
    return { laneId: value.laneId, column: value.column }
  }
  return undefined
}

/** A column that may not be reordered keeps its cards still while something is dragged over it. */
const HOLD_STILL: SortingStrategy = () => null

/**
 * A pointer drop lands on what is UNDER the pointer — a card first (a reorder needs its position),
 * else the column's empty space — and on nothing outside this area's columns: a card released
 * over another lane, or outside the board, snaps back. The keyboard sensor has no pointer, so it
 * takes the nearest corners, which is what `sortableKeyboardCoordinates` aims at.
 */
const collisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCorners(args)
  const within = pointerWithin(args)
  const cards = within.filter((collision) => collision.data?.droppableContainer?.data.current?.type === 'card')
  return cards.length > 0 ? cards : within
}

const DragEnabled = createContext(false)
/** Whether a drop of `card` on `target` would DO something — the column highlight's question. */
const DropJudge = createContext<((card: DndCard, target: DropTarget) => boolean) | null>(null)

export function BoardDnd<T extends BoardCardRun>({
  enabled,
  onDrop,
  judge,
  renderOverlay,
  children,
}: {
  enabled: boolean
  onDrop: (card: DndCard<T>, target: DropTarget) => void
  judge: (card: DndCard<T>, target: DropTarget) => boolean
  renderOverlay: (card: DndCard<T>) => ReactNode
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [active, setActive] = useState<DndCard<T> | null>(null)

  // dnd-kit's defaults would read out ids and coordinates. A person moving a card without seeing
  // it needs the task's name and the column.
  const announcements = useMemo<Announcements>(() => {
    const name = (data: unknown) => {
      const card = cardOf(data)
      return card ? runTitle(card.run) : 'The card'
    }
    const column = (data: unknown) => {
      const target = targetOf(data)
      return target ? BOARD_COLUMN_LABELS[target.column] : undefined
    }
    return {
      onDragStart: ({ active: picked }) => `Picked up ${name(picked.data.current)}, in ${column(picked.data.current)}.`,
      onDragOver: ({ active: moving, over }) =>
        over
          ? `${name(moving.data.current)} is over ${column(over.data.current)}.`
          : `${name(moving.data.current)} is not over a column.`,
      onDragEnd: ({ active: dropped, over }) =>
        over
          ? `${name(dropped.data.current)} dropped on ${column(over.data.current)}.`
          : `${name(dropped.data.current)} dropped. Nothing changed.`,
      onDragCancel: ({ active: cancelled }) =>
        `Moving cancelled. ${name(cancelled.data.current)} stays in ${column(cancelled.data.current)}.`,
    }
  }, [])

  return (
    <DragEnabled.Provider value={enabled}>
      <DropJudge.Provider value={judge as (card: DndCard, target: DropTarget) => boolean}>
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          accessibility={{ announcements }}
          onDragStart={({ active: picked }) => setActive((cardOf(picked.data.current) as DndCard<T> | undefined) ?? null)}
          onDragCancel={() => setActive(null)}
          onDragEnd={({ active: dropped, over }) => {
            setActive(null)
            const card = cardOf(dropped.data.current) as DndCard<T> | undefined
            const target = targetOf(over?.data.current)
            if (card && target) onDrop(card, target)
          }}
        >
          {children}
          <DragOverlay>{active ? renderOverlay(active) : null}</DragOverlay>
        </DndContext>
      </DropJudge.Provider>
    </DragEnabled.Provider>
  )
}

/**
 * A column's drop zone: attach `ref` to the element that holds its cards. `dropState` is `valid`
 * or `invalid` while a card is over THIS column, for the highlight; undefined otherwise (and over
 * the card's own column when that column cannot be reordered — picking a card up is not a drop).
 */
export function useDropColumn(laneId: string, column: BoardColumnId) {
  const { setNodeRef } = useDroppable({
    id: columnDropId(laneId, column),
    data: { type: 'column', laneId, column } satisfies ColumnData,
  })
  const { active, over } = useDndContext()
  const judge = useContext(DropJudge)
  const card = cardOf(active?.data.current)
  const target = targetOf(over?.data.current)
  let dropState: 'valid' | 'invalid' | undefined
  if (card && target && judge && target.laneId === laneId && target.column === column) {
    const home = card.laneId === laneId && card.column === column
    if (!home || isReorderable(column)) dropState = judge(card, target) ? 'valid' : 'invalid'
  }
  return { ref: setNodeRef, dropState }
}

/**
 * One column's cards, sortable among themselves when the column may be reordered (Running, Needs
 * you, Review) and held still otherwise. `renderCard` gets the drag handle to place on the card's
 * top line — `null` when dragging is off — and the column the card is drawn in.
 */
export function ColumnCards<T extends BoardCardRun>({
  laneId,
  column,
  runs,
  renderCard,
}: {
  laneId: string
  column: BoardColumnId
  runs: readonly T[]
  renderCard: (run: T, handle: ReactNode, column: BoardColumnId) => ReactNode
}) {
  const ids = useMemo(() => runs.map((run) => cardDragId(laneId, run.id)), [laneId, runs])
  return (
    <SortableContext items={ids} strategy={isReorderable(column) ? rectSortingStrategy : HOLD_STILL}>
      {runs.map((run) => (
        <SortableCard key={run.id} laneId={laneId} column={column} run={run} renderCard={renderCard} />
      ))}
    </SortableContext>
  )
}

function SortableCard<T extends BoardCardRun>({
  laneId,
  column,
  run,
  renderCard,
}: {
  laneId: string
  column: BoardColumnId
  run: T
  renderCard: (run: T, handle: ReactNode, column: BoardColumnId) => ReactNode
}) {
  const enabled = useContext(DragEnabled)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: cardDragId(laneId, run.id),
    data: { type: 'card', card: { laneId, column, run } } satisfies CardData,
    disabled: !enabled,
  })
  const handle = enabled ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-slot="board-card-handle"
      aria-label={`Move ${runTitle(run)}`}
      {...attributes}
      {...listeners}
      className="-ml-1 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
    >
      <GripVerticalIcon className="size-3.5" aria-hidden="true" />
    </button>
  ) : null
  return (
    <div
      ref={setNodeRef}
      data-slot="board-card-sortable"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // Lifted, not gone: the card keeps its place (dnd-kit measures it) while its copy moves.
      className={cn(isDragging && 'opacity-40')}
    >
      {renderCard(run, handle, column)}
    </div>
  )
}