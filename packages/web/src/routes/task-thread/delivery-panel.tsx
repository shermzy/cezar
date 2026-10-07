import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
} from 'lucide-react'

import { useRunDelivery, useRefreshRunDelivery } from '@/api/queries'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import type { ApiRun, DeliveryRecord, DeliveryStatus } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { isHttpUrl } from '@/lib/utils'

const STATUS: Record<DeliveryStatus, { label: string; tone: 'success' | 'pending' | 'danger' | 'neutral'; pulse?: boolean }> = {
  'waiting-merge': { label: 'Waiting for merge', tone: 'pending', pulse: true },
  'ci-pending': { label: 'Integration CI pending', tone: 'pending', pulse: true },
  'ci-passed': { label: 'Integration CI passed', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'neutral' },
}

function hasAuthoritativePr(run: ApiRun): boolean {
  return (
    run.prRefs?.some((ref) => ref.origin === 'created' || ref.origin === 'marker' || ref.origin === 'legacy') === true ||
    run.markerRefs?.pr !== undefined ||
    isHttpUrl(run.pullRequestUrl) ||
    run.delivery !== undefined
  )
}

function checkedLabel(checkedAt: string): string {
  const parsed = new Date(checkedAt)
  return Number.isNaN(parsed.valueOf()) ? checkedAt : parsed.toLocaleString()
}

function DeliveryEvidence({ delivery }: { delivery: DeliveryRecord }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
      {delivery.repository ? (
        <p className="truncate">
          Repository:{' '}
          {isHttpUrl(delivery.repository.url) ? (
            <a
              href={delivery.repository.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {delivery.repository.owner}/{delivery.repository.name}
            </a>
          ) : (
            `${delivery.repository.owner}/${delivery.repository.name}`
          )}
        </p>
      ) : null}

      {delivery.prs.length > 0 ? (
        <div data-slot="delivery-prs" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span>Pull requests:</span>
          {delivery.prs.map((pr) => (
            <a
              key={`${pr.number}:${pr.url}`}
              data-slot="delivery-pr"
              href={isHttpUrl(pr.url) ? pr.url : undefined}
              target={isHttpUrl(pr.url) ? '_blank' : undefined}
              rel={isHttpUrl(pr.url) ? 'noopener noreferrer' : undefined}
              className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              <GitPullRequestIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span>#{pr.number}</span>
              <span className="text-soft-foreground">{pr.state}</span>
              {isHttpUrl(pr.url) ? <ExternalLinkIcon className="size-3" aria-hidden="true" /> : null}
            </a>
          ))}
        </div>
      ) : null}

      {delivery.prs.filter((pr) => pr.mergeCommitSha).map((pr) => (
        <p key={`${pr.number}:${pr.mergeCommitSha}`} data-slot="delivery-commit" className="min-w-0">
          Merged commit{delivery.prs.length > 1 ? ` for PR #${pr.number}` : ''}:{' '}
          <code
            className="break-all font-mono text-[11px] text-foreground"
            title={pr.mergeCommitSha}
          >
            {pr.mergeCommitSha}
          </code>
        </p>
      ))}

      {delivery.checks.length > 0 ? (
        <div data-slot="delivery-checks" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span>Integration CI:</span>
          {delivery.checks.map((check) => (
            <a
              key={`${check.runId}:${check.runAttempt}`}
              data-slot="delivery-check"
              href={isHttpUrl(check.url) ? check.url : undefined}
              target={isHttpUrl(check.url) ? '_blank' : undefined}
              rel={isHttpUrl(check.url) ? 'noopener noreferrer' : undefined}
              className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              <span>{check.workflow}</span>
              <span className="text-soft-foreground">{check.conclusion ?? check.status}</span>
              {isHttpUrl(check.url) ? <ExternalLinkIcon className="size-3" aria-hidden="true" /> : null}
            </a>
          ))}
        </div>
      ) : null}

      <p className="text-[11px] text-soft-foreground">
        Checked <time dateTime={delivery.checkedAt}>{checkedLabel(delivery.checkedAt)}</time>
      </p>
    </div>
  )
}

export function DeliveryPanel({ run }: { run: ApiRun }) {
  if (!hasAuthoritativePr(run)) return null
  return <DeliveryPanelWithData run={run} />
}

function DeliveryPanelWithData({ run }: { run: ApiRun }) {
  const delivery = useRunDelivery(run.id)
  const refresh = useRefreshRunDelivery(run.id)
  // Run detail can carry a newer invalidation record while the separate stored-only GET still
  // has an older value cached. An association change deliberately marks the embedded record
  // unknown/stale, so it must win until the next explicit refresh.
  const record = run.delivery !== undefined ? run.delivery : delivery.data
  const status = record ? STATUS[record.status] : undefined

  const refreshDelivery = () => {
    refresh.mutate({ projectId: queryScope() }, {
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })
  }

  return (
    <section
      data-slot="delivery-panel"
      aria-label="Delivery tracking"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-card px-3.5 py-3"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {record?.status === 'ci-passed' ? (
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          ) : record?.status === 'blocked' ? (
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <Clock3Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">Delivery tracking</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Read-only merge and integration evidence for this task.
            </p>
          </div>
        </div>

        {record ? (
          <Button
            data-slot="delivery-refresh"
            variant="outline"
            size="sm"
            aria-label="Refresh delivery"
            disabled={refresh.isPending}
            onClick={refreshDelivery}
          >
            <RefreshCwIcon className={refresh.isPending ? 'animate-spin' : undefined} aria-hidden="true" />
            Refresh delivery
          </Button>
        ) : null}
      </div>

      {delivery.isError && run.delivery === undefined ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-danger/30 bg-danger/5 px-2.5 py-2">
          <p className="text-xs text-danger">Could not load delivery state: {delivery.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void delivery.refetch()}>
            Retry
          </Button>
        </div>
      ) : delivery.isPending && record === undefined ? (
        <p className="text-xs text-muted-foreground">Loading delivery state…</p>
      ) : record === null ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-dashed border-border px-2.5 py-2">
          <p className="text-xs text-muted-foreground">No delivery observation has been started.</p>
          <Button data-slot="delivery-track" size="sm" onClick={refreshDelivery} disabled={refresh.isPending}>
            <GitPullRequestIcon aria-hidden="true" />
            Track delivery
          </Button>
        </div>
      ) : record ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Pill data-slot="delivery-status" dot={status?.tone} pulse={status?.pulse}>
              {status?.label ?? record.status}
            </Pill>
            {record.stale ? <Pill dot="danger">Stale evidence</Pill> : null}
          </div>
          <DeliveryEvidence delivery={record} />
          <p className="border-t border-border pt-2 text-xs text-muted-foreground">
            {record.reason ?? (record.status === 'ci-passed'
              ? 'All observed target-branch CI workflows passed.'
              : 'No actionable integration result is available yet.')}
          </p>
          <p className="text-[11px] text-soft-foreground">
            No release, deployment, or acceptance is claimed.
          </p>
        </>
      ) : null}
    </section>
  )
}
