import type { ReactNode } from 'react'
import type { To } from 'react-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { RunningBeam } from '@/components/running-beam'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention, type AttentionInput } from '@/lib/attention'
import type { BoardAction } from '@/lib/board-moves'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { runTitle, type RunTitleInput } from '@/lib/task-groups'
import { formatCost, scheduledResume, taskReference, type TaskReference, type TaskReferenceInput } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

/**
 * Everything a card reads, and nothing more — a composite of the shared helpers' own input types,
 * so a full `RunRecord` and a slim cross-project `RunIndexEntry` both fit (spec § Phase 1b).
 *
 * `runner`, `model` and `variant` are optional because the index carried none of them before
 * phase 1c, and still carries no `variant`: a card without them simply omits that part. `to` is a
 * READY link target — the all-projects board passes `scopeTo(run.projectId, '/tasks/<id>')`, which
 * the scoped `Link` leaves untouched because it already starts with `/p/`; absent, the card links
 * into the active project as it always has.
 */
export type BoardCardRun = Pick<RunRecord, 'id' | 'startedAt' | 'createdAt' | 'finishedAt'> &
  RunTitleInput &
  AttentionInput &
  TaskReferenceInput & {
    runner?: RunRecord['runner']
    model?: RunRecord['model']
    variant?: RunRecord['variant']
    to?: To
  }

/** How a pending card says what it is waiting for, until the run's real status changes. */
const PENDING_LABELS: Record<BoardAction, string> = {
  accept: 'accepting…',
  finish: 'finishing…',
  cancel: 'cancelling…',
  'stop-resume': 'stopping the resume…',
  rerun: 'starting again…',
}

/**
 * One run on the Board (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c).
 *
 * - **Top line:** `#123 · claude · T3 team · opus` — the issue/PR reference (`taskReference`,
 *   linked to its forge page when the URL is known), then `agent` (`agentSummary`'s text). The
 *   drag handle and the ⋯ menu sit at its two ends.
 * - **The link** (`data-slot="board-card"`) holds the title and the status line, and opens the
 *   task page. It is a SIBLING of the handle, the reference link and the menu, never their
 *   parent: interactive content inside an `<a>` is invalid HTML, and a drag that started on a link
 *   would end in a navigation.
 * - **Running** cards (`status: 'running'`, monitoring included) wear the `RunningBeam` — slower
 *   and dimmer while monitoring — and a `.shimmer-text` status label instead of a pulsing dot. The
 *   beam paints the card surface and its rim, so the shell drops its own `bg-card` and border
 *   colour then.
 * - **Pending** (an action was confirmed and the run has not changed yet): dimmed, `aria-busy`, and
 *   the status label says what it waits for.
 * - **`overlay`**: the copy that follows the pointer while dragging — no link, no controls.
 *
 * Everything shown is read through the list's own helpers (`runTitle`, `taskReference`,
 * `formatCost`, `scheduledResume`, `deriveAttention`), so a card never words a run differently
 * from its row.
 */
export function BoardCard({
  run,
  now,
  agent,
  handle,
  menu,
  pending,
  overlay = false,
}: {
  run: BoardCardRun
  now: number
  /** `runner · account · model`, or nothing when no runner is known (`agentSummary`). */
  agent?: string
  handle?: ReactNode
  menu?: ReactNode
  pending?: BoardAction
  overlay?: boolean
}) {
  const attention = deriveAttention(run)
  const working = run.status === 'running'
  const resume = scheduledResume(run, new Date(now))
  const reference = taskReference(run)
  const cost = formatCost(run.costUsd)
  // An unparseable `finishedAt` reads as NaN, which would print "NaNd" — count to `now` instead.
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN
  const elapsed = shortAge(run.startedAt ?? run.createdAt, Number.isNaN(finished) ? now : finished)
  const label = pending ? PENDING_LABELS[pending] : resume ? `${attention.label} ${resume.label}` : attention.label

  const top =
    reference || agent || handle || menu ? (
      <div data-slot="board-card-top" className="flex min-h-6 items-center gap-1 text-[9.5px] tracking-tighter text-soft-foreground">
        {handle}
        <span className="flex min-w-0 flex-1 items-center gap-1 font-mono">
          {reference ? <ReferenceChip reference={reference} linked={!overlay} /> : null}
          {reference && agent ? <span aria-hidden="true">·</span> : null}
          {agent ? (
            <span data-slot="board-card-agent" className="truncate" title={agent}>
              {agent}
            </span>
          ) : null}
        </span>
        {menu}
      </div>
    ) : null

  const body = (
    <>
      <span className="line-clamp-2 font-medium">{runTitle(run)}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
        <span data-slot="board-card-status" className="inline-flex items-center gap-1.5" title={resume?.title}>
          {/* The beam carries "working" for running cards, so their dot is still. */}
          <StatusDot tone={attention.tone} pulse={attention.pulse && !working} />
          {working && !pending ? <span className="shimmer-text">{label}</span> : label}
        </span>
        {elapsed ? <span className="text-soft-foreground">{elapsed}</span> : null}
        {cost ? <span>{cost}</span> : null}
        {run.variant ? <span>variant {run.variant}</span> : null}
        {run.dispatch?.parentRunId ? (
          <span>
            <span aria-hidden="true">↳</span>
            <span className="sr-only">child task</span>
            <span aria-hidden="true"> child</span>
          </span>
        ) : null}
      </span>
    </>
  )

  const shell = (
    <div
      data-slot={overlay ? 'board-card-overlay' : 'board-card-shell'}
      data-run-id={run.id}
      data-pending={pending}
      aria-busy={pending ? true : undefined}
      className={cn(
        'flex flex-col gap-1 rounded-md border px-2.5 pt-1.5 pb-2.5 text-[13px] text-card-foreground transition-[background-color,border-color,opacity]',
        // Running: the beam paints the surface AND the rim. Only the inner half of its crisp line
        // survives the clip — the very pixel an opaque border would paint over — so the border
        // steps aside too, as BoardUI's wrapped composer has none (`agent-composer.tsx`).
        working ? 'border-transparent bg-transparent' : 'border-border bg-card hover:bg-card-2',
        pending && 'opacity-60',
        overlay && 'shadow-md',
      )}
    >
      {top}
      {overlay ? (
        <div className="flex flex-col gap-1.5">{body}</div>
      ) : (
        <Link
          to={run.to ?? `/tasks/${encodeURIComponent(run.id)}`}
          data-slot="board-card"
          data-run-id={run.id}
          data-status={run.status}
          className="flex flex-col gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </Link>
      )}
    </div>
  )

  if (!working) return shell
  const monitoring = run.activity === 'monitoring'
  return (
    <RunningBeam
      className="rounded-md"
      line={2}
      // Still running, but watching its own downstream work (#490): slower and dimmer.
      speed={monitoring ? 9 : 4.5}
      intensity={monitoring ? 0.35 : 0.7}
    >
      {shell}
    </RunningBeam>
  )
}

/** `#123`, linked to its forge page when the URL is known; the kind rides the accessible name. */
function ReferenceChip({ reference, linked }: { reference: TaskReference; linked: boolean }) {
  const name = `${reference.kind} #${reference.number}`
  if (linked && reference.url) {
    return (
      <a
        data-slot="board-card-ref"
        href={reference.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={name}
        title={name}
        className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        #{reference.number}
      </a>
    )
  }
  return (
    <span data-slot="board-card-ref" title={name} className="shrink-0 text-muted-foreground">
      <span className="sr-only">{reference.kind} </span>#{reference.number}
    </span>
  )
}
