import { TriangleAlertIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { To } from 'react-router'

import { useAgentProfiles, useProjects, useRunsForProject, useRunsIndex } from '@/api/queries'
import type { ApiRun, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS } from '@/lib/board-columns'
import { groupLanes } from '@/lib/board-lanes'
import { scopeTo } from '@/lib/project-router'
import { useIsDesktop } from '@/lib/use-desktop'
import { useNow } from '@/lib/use-now'
import { useProjectOrder } from '@/lib/use-project-order'
import { cn } from '@/lib/utils'

import { BoardLane, LANE_GRID_CLASS, LANE_GRID_MIN_WIDTH_CLASS } from './board-lane'
import { BoardMoveDialog } from './board-move-dialog'
import { useBoardMoves } from './use-board-moves'

/** The global Tasks page's backstop interval, for the same reason: the workspace stream's `run`
 *  events already invalidate the index (debounced, `global-events.tsx`); this covers a dropped
 *  socket or a frozen tab. */
const RUNS_INDEX_POLL_MS = 15_000

/** How often the card clocks re-read the time — the per-project board's tick. */
const CLOCK_TICK_MS = 30_000

/** One card on this board: a cross-project index row, or a live record of an UNREGISTERED boot
 *  folder stamped with its project — either way carrying its ready link. */
type AllBoardsRun = (RunIndexEntry | (ApiRun & { projectId: string })) & { to: To }

/**
 * The cards: the cross-project index, plus — when the boot folder is UNREGISTERED, which the index
 * never walks (`server.ts`, `GET /workspace/runs-index` lists registered projects only) — that
 * folder's own live run list. Merged the way the palette's `mergeTasks` merges them: per run, and
 * the live row wins, because it is the one the workspace stream patches.
 *
 * Every card gets `scopeTo(projectId, '/tasks/<id>')`: a ready target the scoped `Link` leaves
 * alone, so a card opens its task in its OWN project rather than in whatever scope is active.
 */
function boardRuns(
  indexed: readonly RunIndexEntry[],
  unregisteredBootId: string | null,
  bootRuns: readonly ApiRun[] | undefined,
): AllBoardsRun[] {
  const live: Array<ApiRun & { projectId: string }> =
    unregisteredBootId === null ? [] : (bootRuns ?? []).map((run) => ({ ...run, projectId: unregisteredBootId }))
  const liveKeys = new Set(live.map((run) => `${run.projectId}/${run.id}`))
  const rows = [...live, ...indexed.filter((entry) => !liveKeys.has(`${entry.projectId}/${entry.id}`))]
  return rows.map((run) => ({ ...run, to: scopeTo(run.projectId, `/tasks/${encodeURIComponent(run.id)}`) }))
}

/**
 * `/board` — every project's board at once, one swimlane per project in sidebar order (spec
 * `.ai/specs/2026-10-04-kanban-board.md` § Phase 1b). Outside `/p/:projectId` on purpose, like
 * `/tasks` and `/dashboard`: "every project" scoped to one project is a contradiction.
 *
 * Data: the workspace runs index (one request for the whole registry, kept live by the stream's
 * debounced invalidation, with a 15 s poll as backstop) joined to `useProjects()`. An unregistered
 * boot folder is outside the index, so its lane reads `useRunsForProject(boot, boot)` — the same
 * stream-patched `default` entry the shell already reads — and merges it in.
 *
 * Lanes open and close on their own from their CURRENT kind (`active` open, `done-only` closed,
 * `quiet` behind a toggle) until the user toggles one; that choice then sticks for this visit and
 * is never persisted — a board that remembered stale collapse state would hide new work.
 *
 * Loading waits for every source the lanes need, so the "no tasks" hint can never flash before
 * the boot folder's runs arrive. An error screen shows only when a failing query has no data: a
 * failed background refetch keeps the board.
 *
 * Moves (spec § Phase 1c): each open lane is its own drag area, and every action goes to the
 * card's OWN project through the project-explicit client calls — one shared confirm dialog.
 */
export function AllBoardsRoute() {
  const projects = useProjects()
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  const bootId = projects.data?.bootProject ?? null
  // Called unconditionally (hooks), and cheap: it is the `default` entry the app shell already
  // reads for its own badge. It only FEEDS the board when the boot folder is unregistered.
  const bootRuns = useRunsForProject(bootId, bootId)
  const { order } = useProjectOrder()
  const now = useNow(CLOCK_TICK_MS)
  const profiles = useAgentProfiles()
  const desktop = useIsDesktop()
  // Every card carries its project (`boardRuns` stamps the boot folder's own rows too).
  const moves = useBoardMoves(
    useCallback((run: { projectId?: string }) => run.projectId ?? bootId ?? 'default', [bootId]),
  )
  const agentLine = useMemo(() => ({ profiles: profiles.data?.profiles }), [profiles.data])
  const [showOlderHistory, setShowOlderHistory] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  /** Explicit per-project choices, which win over the live default until the page unmounts. */
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map())

  const unregisteredBootId = projects.data?.projects.find((project) => project.unregistered)?.id ?? null
  const needsBootRuns = unregisteredBootId !== null

  const board = useMemo(() => {
    if (!projects.data || !index.data || (needsBootRuns && !bootRuns.data)) return undefined
    const runs = boardRuns(index.data.runs, unregisteredBootId, needsBootRuns ? bootRuns.data : undefined)
    return {
      lanes: groupLanes(projects.data.projects, order, runs, {
        now,
        showOlderHistory,
        truncatedIds: index.data.truncated,
      }),
      // The cap that produced the index, so a lane's truncation notice names the real number.
      perProjectLimit: index.data.perProjectLimit,
    }
  }, [projects.data, index.data, needsBootRuns, unregisteredBootId, bootRuns.data, order, now, showOlderHistory])

  const failure =
    (projects.isError && !projects.data ? projects.error : null) ??
    (index.isError && !index.data ? index.error : null) ??
    (needsBootRuns && bootRuns.isError && !bootRuns.data ? bootRuns.error : null)
  if (failure) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        title="Couldn't load boards"
        subtitle={failure instanceof Error ? failure.message : undefined}
      />
    )
  }
  if (!board) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading boards…
      </div>
    )
  }
  const { lanes, perProjectLimit } = board

  const shown = lanes.filter((lane) => lane.kind !== 'quiet')
  const quiet = lanes.filter((lane) => lane.kind === 'quiet')
  const hiddenHistory = lanes.reduce((sum, lane) => sum + lane.hiddenHistory, 0)
  // "No tasks yet" means no non-archived run in any listed project — hidden old outcomes count.
  const hasTasks = lanes.some(
    (lane) => lane.hiddenHistory > 0 || BOARD_COLUMNS.some((id) => lane.columns[id].length > 0),
  )

  const renderLane = (lane: (typeof lanes)[number]) => {
    const fallback = lane.kind === 'active'
    const expanded = choices.get(lane.project.id) ?? fallback
    return (
      <BoardLane
        key={lane.project.id}
        lane={lane}
        expanded={expanded}
        now={now}
        perProjectLimit={perProjectLimit}
        bootId={bootId}
        moves={moves}
        agentLine={agentLine}
        dragEnabled={desktop}
        onToggle={() =>
          setChoices((current) => {
            const next = new Map(current)
            next.set(lane.project.id, !(current.get(lane.project.id) ?? fallback))
            return next
          })
        }
      />
    )
  }

  return (
    <div data-slot="all-boards" className="flex h-full min-h-0 flex-col">
      <header className="hidden items-center justify-between gap-3 px-4 pt-4 md:flex md:px-6">
        <h1 className="text-sm font-semibold text-foreground">All boards</h1>
      </header>
      {/* The ONE scroll container, both directions, so the column-header row's `sticky top-0`
          really sticks while the lanes scroll under it. */}
      <div data-slot="all-boards-scroller" className="min-h-0 flex-1 overflow-auto px-4 pb-4 md:px-6">
        <div className={cn('flex flex-col gap-3', LANE_GRID_MIN_WIDTH_CLASS)}>
          {/* Visual only: every cell carries its own "Running, 2 tasks" label. The transparent
              border stands in for the lane's 1 px one, so the header's tracks are exactly as wide as
              the lane bodies' and each header sits over its column. */}
          <div
            aria-hidden="true"
            data-slot="board-column-headers"
            className={cn(
              'sticky top-0 z-10 hidden border border-transparent bg-background px-1.5 pt-3 pb-1 text-[12px] font-semibold text-soft-foreground md:grid',
              LANE_GRID_CLASS,
            )}
          >
            {BOARD_COLUMNS.map((id) => (
              <span key={id} className="px-2">
                {BOARD_COLUMN_LABELS[id]}
              </span>
            ))}
          </div>
          {hasTasks ? null : (
            <p data-slot="board-empty-hint" className="pt-3 text-[13px] text-soft-foreground md:pt-0">
              No tasks yet in any project
            </p>
          )}
          {shown.map(renderLane)}
          {showQuiet ? quiet.map(renderLane) : null}
          {/* Bottom of the lane list, not the page header: the header is hidden below `md`, and
              these must be reachable at every width. */}
          {quiet.length > 0 || hiddenHistory > 0 || showOlderHistory ? (
            <div data-slot="all-boards-toggles" className="flex flex-wrap items-center gap-2">
              {quiet.length > 0 ? (
                <Button
                  data-slot="board-quiet-toggle"
                  variant="ghost"
                  size="sm"
                  aria-expanded={showQuiet}
                  onClick={() => setShowQuiet((value) => !value)}
                >
                  {showQuiet
                    ? 'Hide quiet projects'
                    : `Show ${quiet.length} quiet ${quiet.length === 1 ? 'project' : 'projects'}`}
                </Button>
              ) : null}
              {hiddenHistory > 0 || showOlderHistory ? (
                <Button
                  data-slot="board-older-toggle"
                  variant="ghost"
                  size="sm"
                  aria-pressed={showOlderHistory}
                  onClick={() => setShowOlderHistory((value) => !value)}
                >
                  {showOlderHistory ? 'Hide older outcomes' : `Show ${hiddenHistory} older outcomes`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <BoardMoveDialog moves={moves} />
    </div>
  )
}
