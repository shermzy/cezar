import { ChevronDownIcon } from 'lucide-react'
import { useId } from 'react'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, type BoardColumnId } from '@/lib/board-columns'
import type { Lane, LaneRunInput } from '@/lib/board-lanes'
import { Link, scopeTo } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { BoardCard, type BoardCardRun } from './board-card'

/**
 * The five-column track every lane body and the sticky column-header row share, so a cell always
 * sits under its header. 180 px per column is phase 1's minimum; below `md` there is no grid at
 * all — a lane stacks its non-empty columns instead.
 */
export const LANE_GRID_CLASS = 'gap-3 md:grid-cols-[repeat(5,minmax(180px,1fr))]'

/** The width a lane needs at its minimum: five 180 px columns (900) and four 12 px gaps (48), plus
 *  what surrounds the grid in a lane: the body's `px-1.5` (2 × 6 = 12) and the lane's 1 px border
 *  on each side (2) — 962 px. The board's scroller scrolls sideways below it rather than squeezing
 *  a column under 180 px. */
export const LANE_GRID_MIN_WIDTH_CLASS = 'md:min-w-[962px]'

/** How a lane header counts a column: `2 running · 1 needs you · 3 done`. */
const COUNT_WORDS: Record<BoardColumnId, string> = {
  queued: 'queued',
  running: 'running',
  'needs-you': 'needs you',
  review: 'in review',
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
 * `(1 done)`, expanded `1 running · 1 done`. A truncated lane says so in its header, linking to
 * the project's board, where the full run list lives.
 *
 * The body is rendered (and `hidden`) even when collapsed, so `aria-controls` always names an
 * element, but it holds no cards until it opens.
 */
export function BoardLane<T extends BoardCardRun & LaneRunInput>({
  lane,
  expanded,
  onToggle,
  now,
  perProjectLimit,
}: {
  lane: Lane<ProjectListEntry, T>
  expanded: boolean
  onToggle: () => void
  now: number
  /** The runs index's per-project cap — what a truncated lane's notice names. */
  perProjectLimit: number
}) {
  const headingId = useId()
  const bodyId = useId()
  const { project } = lane
  const counts = laneCounts(lane.columns)
  const projectBoard = scopeTo(project.id, '/board')

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
        {expanded
          ? BOARD_COLUMNS.map((id) => <BoardLaneCell key={id} id={id} runs={lane.columns[id]} now={now} />)
          : null}
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
function BoardLaneCell<T extends BoardCardRun>({ id, runs, now }: { id: BoardColumnId; runs: readonly T[]; now: number }) {
  const label = BOARD_COLUMN_LABELS[id]
  return (
    <div
      role="group"
      data-slot="board-cell"
      data-column={id}
      aria-label={`${label}, ${runs.length} ${runs.length === 1 ? 'task' : 'tasks'}`}
      className={cn('min-h-10 min-w-0 flex-col gap-2 rounded-md bg-muted p-2', runs.length === 0 ? 'hidden md:flex' : 'flex')}
    >
      <span aria-hidden="true" className="px-1 text-[12px] font-semibold text-soft-foreground md:hidden">
        {label} · {runs.length}
      </span>
      {runs.map((run) => (
        <BoardCard key={run.id} run={run} now={now} />
      ))}
    </div>
  )
}
