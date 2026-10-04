import type { To } from 'react-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { deriveAttention, type AttentionInput } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { runTitle, type RunTitleInput } from '@/lib/task-groups'
import { formatCost, scheduledResume, taskReference, type TaskReferenceInput } from '@/lib/tasks-table'

/**
 * Everything a card reads, and nothing more — a composite of the shared helpers' own input types,
 * so a full `RunRecord` and a slim cross-project `RunIndexEntry` both fit (spec § Phase 1b).
 *
 * `runner`, `model` and `variant` are optional because the index does not carry them: a card
 * without them simply omits that chip. `to` is a READY link target — the all-projects board passes
 * `scopeTo(run.projectId, '/tasks/<id>')`, which the scoped `Link` leaves untouched because it
 * already starts with `/p/`; absent, the card links into the active project as it always has.
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

/**
 * One run on the Board. The whole card is the link to the task page — the board is a map of
 * where work stands, and every card is a way into it.
 *
 * Everything shown is read through the list's own helpers (`runTitle`, `taskReference`,
 * `formatCost`, `scheduledResume`, `deriveAttention`), so a card can never word a run
 * differently from its row. Elapsed is start → finish for an ended run, start → now while it
 * works, and created → now while it waits.
 */
export function BoardCard({ run, now }: { run: BoardCardRun; now: number }) {
  const attention = deriveAttention(run)
  const resume = scheduledResume(run, new Date(now))
  const reference = taskReference(run)
  const cost = formatCost(run.costUsd)
  // An unparseable `finishedAt` reads as NaN, which would print "NaNd" — count to `now` instead.
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN
  const elapsed = shortAge(run.startedAt ?? run.createdAt, Number.isNaN(finished) ? now : finished)

  return (
    <Link
      to={run.to ?? `/tasks/${encodeURIComponent(run.id)}`}
      data-slot="board-card"
      data-run-id={run.id}
      data-status={run.status}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-[13px] text-card-foreground transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="line-clamp-2 font-medium">{runTitle(run)}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
        <span data-slot="board-card-status" className="inline-flex items-center gap-1.5" title={resume?.title}>
          <StatusDot tone={attention.tone} pulse={attention.pulse} />
          {resume ? `${attention.label} ${resume.label}` : attention.label}
        </span>
        {run.runner ? <span>{run.model ? `${run.runner} · ${run.model}` : run.runner}</span> : null}
        {elapsed ? <span className="text-soft-foreground">{elapsed}</span> : null}
        {cost ? <span>{cost}</span> : null}
        {reference ? (
          <span data-slot="board-card-ref">
            {reference.kind} #{reference.number}
          </span>
        ) : null}
        {run.variant ? <span>variant {run.variant}</span> : null}
        {run.dispatch?.parentRunId ? (
          <span>
            <span aria-hidden="true">↳</span>
            <span className="sr-only">child task</span>
            <span aria-hidden="true"> child</span>
          </span>
        ) : null}
      </span>
    </Link>
  )
}
