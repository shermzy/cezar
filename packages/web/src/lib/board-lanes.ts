import { BOARD_COLUMNS, groupBoard, type BoardColumnId, type BoardRunInput } from '@/lib/board-columns'
import { orderSidebarProjects, type SidebarProject } from '@/lib/project-order'

/**
 * The all-projects board's swimlanes (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1b):
 * one lane per registered project, in the SIDEBAR's order, each holding the same six columns the
 * per-project board shows. Pure on purpose — the failure modes in `board-lanes.test.ts` are the
 * contract, and nothing here touches React or the router, nor the clock beyond `now`'s default.
 */

/** A run as a lane reads it: whatever `groupBoard` reads, plus the project it belongs to. */
export type LaneRunInput = BoardRunInput & { projectId: string }

/**
 * - `active`: something is queued, running, needs you or waits for review — the lane opens.
 * - `done-only`: only terminal outcomes have visible cards — the lane is collapsed.
 * - `quiet`: nothing visible at all — the lane waits behind "Show N quiet projects".
 */
export type LaneKind = 'active' | 'done-only' | 'quiet'

export interface Lane<P extends SidebarProject, T extends LaneRunInput> {
  project: P
  columns: Record<BoardColumnId, T[]>
  /** Terminal runs outside the 7-day window, for the board's one history toggle. */
  hiddenHistory: number
  /** The runs index capped this project at its newest N, so the lane may be missing older work. */
  truncated: boolean
  kind: LaneKind
}

/** Every column but the terminal outcomes — the ones that mean "this project has work in flight". */
const ACTIVE_COLUMNS = BOARD_COLUMNS.filter((id) => id !== 'done' && id !== 'not-doing')

/**
 * One lane per project, in sidebar order (`orderSidebarProjects`, the sidebar's own helper), with
 * each lane's columns built by `groupBoard` — so a lane orders its cards exactly as the
 * per-project board does. Runs whose `projectId` is not a listed project are dropped: a lane is
 * only ever drawn for something the registry names.
 */
export function groupLanes<P extends SidebarProject, T extends LaneRunInput>(
  projects: readonly P[],
  order: readonly string[],
  runs: readonly T[],
  {
    now = Date.now(),
    showOlderHistory = false,
    truncatedIds = [],
  }: { now?: number; showOlderHistory?: boolean; truncatedIds?: readonly string[] } = {},
): Lane<P, T>[] {
  const runsByProject = new Map(projects.map((project): [string, T[]] => [project.id, []]))
  for (const run of runs) runsByProject.get(run.projectId)?.push(run)
  const truncatedSet = new Set(truncatedIds)
  return orderSidebarProjects(projects, order).map((project) => {
    const { columns, hiddenHistory } = groupBoard(runsByProject.get(project.id) ?? [], { now, showOlderHistory })
    const isTruncated = truncatedSet.has(project.id)
    return { project, columns, hiddenHistory, truncated: isTruncated, kind: laneKind(columns, isTruncated) }
  })
}

/** A truncated lane (the index kept only its newest N runs, the index's `perProjectLimit`) with
 *  nothing visible is `done-only`, not `quiet`: its truncation notice is the only way to the work
 *  the index left out, so it must stay on the board. */
function laneKind(columns: Record<BoardColumnId, readonly unknown[]>, truncated: boolean): LaneKind {
  if (ACTIVE_COLUMNS.some((id) => columns[id].length > 0)) return 'active'
  return columns.done.length > 0 || columns['not-doing'].length > 0 || truncated ? 'done-only' : 'quiet'
}
