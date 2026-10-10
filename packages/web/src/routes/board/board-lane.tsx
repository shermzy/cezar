import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useId, useMemo, type ReactNode } from 'react'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { getProjectUiState, putProjectUiState } from '@/api/client'
import { agentSummary, type AgentSummaryInput } from '@/lib/agent-summary'
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, type BoardColumnId } from '@/lib/board-columns'
import type { Lane, LaneRunInput } from '@/lib/board-lanes'
import { applyBoardOrder } from '@/lib/board-moves'
import { Link, scopeTo } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { BoardCard, type BoardCardRun } from './board-card'
import { BoardDnd, ColumnCards, useDropColumn } from './board-dnd'
import { MovableBoardCard, type AgentLineOptions } from './movable-board-card'
import type { BoardMoves } from './use-board-moves'
import { projectUiStateKey, useBoardDrop, useBoardOrder } from './use-board-order'

/**
 * The six-column track every lane body and the sticky column-header row share, so a cell always
 * sits under its header. 180 px per column is phase 1's minimum; below `md` there is no grid at
 * all — a lane stacks its non-empty columns instead.
 */
export const LANE_GRID_CLASS = 'gap-3 md:grid-cols-[repeat(6,minmax(180px,1fr))]'

/** The width a lane needs at its minimum: six 180 px columns (1080) and five 12 px gaps (60), plus
 *  what surrounds the grid in a lane: the body's `px-1.5` (2 × 6 = 12) and the lane's 1 px border
 *  on each side (2) — 1154 px. The board's scroller scrolls sideways below it rather than squeezing
 *  a column under 180 px. */
export const LANE_GRID_MIN_WIDTH_CLASS = 'md:min-w-[1154px]'

/** How a lane header counts columns, including `not doing` and `done`. */
const COUNT_WORDS: Record<BoardColumnId, string> = {
  queued: 'queued',
  running: 'running',
  'needs-you': 'needs you',
  review: 'in review',
  'not-doing': 'not doing',
  done: 'done',
}

function laneCounts(columns: Record<BoardColumnId, readonly unknown[]>): string {
  return BOARD_COLUMNS.filter((id) => columns[id].length > 0)
    .map((id) => `${columns[id].length} ${COUNT_WORDS[id]}`)
    .join(' · ')
}

/**
 * One project's swimlane on the all-projects board (spec `.ai/specs/2026-10-04-kanban-board.md`
 * § Phase 1b → Layout, Accessibility).
 *
 * A `<section>` labelled by its heading — the project name, which links to that project's own
 * board. The disclosure button owns `aria-expanded`/`aria-controls`; collapsed, the counts read
 * `(1 done · 1 not doing)`, expanded `1 running · 1 done`. A truncated lane says so in its
 * header, linking to the project's board, where the full run list lives.
 *
 * The body is rendered (and `hidden`) even when collapsed, so `aria-controls` always names an
 * element, but it holds no cards until it opens.
 *
 * An open lane is its own drag area (spec § Phase 1c → Moving cards, "On All boards"): its cards
 * reorder and act inside it, through its OWN project's ui-state and project-explicit routes, and
 * a card dragged out of it has nowhere to land, so it snaps back.
 */
export function BoardLane<T extends BoardCardRun & LaneRunInput & AgentSummaryInput>({
  lane,
  expanded,
  onToggle,
  now,
  perProjectLimit,
  bootId,
  moves,
  agentLine,
  dragEnabled,
}: {
  lane: Lane<ProjectListEntry, T>
  expanded: boolean
  onToggle: () => void
  now: number
  /** The runs index's per-project cap — what a truncated lane's notice names. */
  perProjectLimit: number
  /** The boot project's id: its ui-state lives under the `default`-led cache key. */
  bootId: string | null
  moves: BoardMoves
  agentLine: AgentLineOptions
  dragEnabled: boolean
}) {
  const headingId = useId()
  const bodyId = useId()
  const { project } = lane
  const counts = laneCounts(lane.columns)
  const projectBoard = scopeTo(project.id, '/board')
  // Read only while the lane is open — a collapsed lane shows no cards to order.
  const order = useBoardOrder({
    queryKey: projectUiStateKey(project.id, bootId),
    read: ({ signal }) => getProjectUiState(project.id, { signal }),
    write: (patch) => putProjectUiState(project.id, patch),
    enabled: expanded,
  })
  const columns = useMemo(() => applyBoardOrder(lane.columns, order.order), [lane.columns, order.order])
  const drop = useBoardDrop({ columns, order, moves })
  // A confirmed card now drawn in another column has landed — also while the lane is collapsed,
  // as it may be once its last active card is done.
  const { observe } = moves
  useEffect(() => {
    observe(project.id, columns)
  }, [columns, observe, project.id])
  const renderCard = (run: T, handle: ReactNode, column: BoardColumnId) => (
    <MovableBoardCard run={run} column={column} handle={handle} now={now} moves={moves} agentLine={agentLine} />
  )

  return (
    <section
      data-slot="board-lane"
      data-project-id={project.id}
      data-kind={lane.kind}
      aria-labelledby={headingId}
      className="rounded-lg border border-border"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1">
        <button
          type="button"
          data-slot="board-lane-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
          onClick={onToggle}
          className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDownIcon
            className={cn('size-3.5 text-muted-foreground transition-transform', !expanded && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
        <h2 id={headingId} className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          <Link to={projectBoard} data-slot="board-lane-project" className="hover:underline">
            {project.name}
          </Link>
        </h2>
        {counts ? (
          <span data-slot="board-lane-counts" className="text-[12px] text-soft-foreground">
            {expanded ? counts : `(${counts})`}
          </span>
        ) : null}
        {lane.truncated ? (
          <Link
            to={projectBoard}
            data-slot="board-lane-truncated"
            className="text-[11.5px] text-soft-foreground underline-offset-2 hover:underline"
          >
            Showing the newest {perProjectLimit} — open this project&rsquo;s board for the rest
          </Link>
        ) : null}
      </div>
      <div
        id={bodyId}
        data-slot="board-lane-body"
        hidden={!expanded}
        className={cn('flex flex-col px-1.5 pb-1.5 md:grid', LANE_GRID_CLASS)}
      >
        {expanded ? (
          <BoardDnd
            enabled={dragEnabled}
            onDrop={drop.onDrop}
            judge={drop.judge}
            renderOverlay={(card) => (
              <BoardCard run={card.run} now={now} agent={agentSummary(card.run, agentLine)?.text} overlay />
            )}
          >
            {BOARD_COLUMNS.map((id) => (
              <BoardLaneCell key={id} laneId={project.id} id={id} runs={columns[id]} renderCard={renderCard} />
            ))}
          </BoardDnd>
        ) : null}
      </div>
    </section>
  )
}

/**
 * One column of one lane: a labelled GROUP ("Running, 2 tasks"), not a region — a 40-project
 * workspace must not grow 200 landmarks. From `md` up every cell is drawn, under the board's
 * sticky header row; below `md` an empty cell is not drawn at all and a visible label takes the
 * header row's place.
 */
function BoardLaneCell<T extends BoardCardRun>({
  laneId,
  id,
  runs,
  renderCard,
}: {
  laneId: string
  id: BoardColumnId
  runs: readonly T[]
  renderCard: (run: T, handle: ReactNode, column: BoardColumnId) => ReactNode
}) {
  const label = BOARD_COLUMN_LABELS[id]
  const drop = useDropColumn(laneId, id)
  return (
    <div
      ref={drop.ref}
      role="group"
      data-slot="board-cell"
      data-column={id}
      data-drop={drop.dropState}
      aria-label={`${label}, ${runs.length} ${runs.length === 1 ? 'task' : 'tasks'}`}
      className={cn(
        'min-h-10 min-w-0 flex-col gap-2 rounded-md bg-muted p-2 transition-shadow',
        runs.length === 0 ? 'hidden md:flex' : 'flex',
        drop.dropState === 'valid' && 'ring-2 ring-ring/60',
        drop.dropState === 'invalid' && 'ring-1 ring-border',
      )}
    >
      <span aria-hidden="true" className="px-1 text-[12px] font-semibold text-soft-foreground md:hidden">
        {label} · {runs.length}
      </span>
      <ColumnCards laneId={laneId} column={id} runs={runs} renderCard={renderCard} />
    </div>
  )
}
