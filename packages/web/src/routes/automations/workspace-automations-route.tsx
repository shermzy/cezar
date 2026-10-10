import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { scheduleLabel } from '@open-mercato/cezar-api-client'

import {
  createWorkspaceAutomation,
  deleteWorkspaceAutomation,
  getWorkspaceAutomations,
  updateWorkspaceAutomation,
} from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { AutomationEditor } from './editor'
import type { CreateAutomationInput, WorkspaceAutomationEntry, WorkspaceAutomationTarget, WorkspaceScheduleAutomation } from '@open-mercato/cezar-api-client'

const queryKey = ['workspace-automations'] as const

function dateTime(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return value
  }
}

function statusText(target: WorkspaceAutomationTarget): string {
  switch (target.status) {
    case 'scheduled': return 'Scheduled'
    case 'paused': return 'Paused'
    case 'auto-paused': return 'Paused after failures'
    case 'unavailable': return 'Repository unavailable'
  }
}

function TargetRow({ target, timeZone }: { target: WorkspaceAutomationTarget; timeZone: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2 text-sm">
      <span className="min-w-36 flex-1 font-medium">{target.name}</span>
      <span className="text-muted-foreground">{statusText(target)}</span>
      {target.nextRunAt ? <span className="text-muted-foreground">Next {dateTime(target.nextRunAt, timeZone)}</span> : null}
      {target.latestLog?.runId && target.projectId ? (
        <Link className="text-primary underline-offset-4 hover:underline" to={`/p/${encodeURIComponent(target.projectId)}/tasks/${encodeURIComponent(target.latestLog.runId)}`}>
          Latest task
        </Link>
      ) : target.latestLog ? <span className="text-muted-foreground">Latest: {target.latestLog.result}</span> : null}
    </div>
  )
}

export function WorkspaceAutomationsRoute({ mode = 'list' }: { mode?: 'list' | 'new' | 'edit' }) {
  const { automationId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getWorkspaceAutomations({ signal }),
  })
  const data = query.data
  const refresh = () => { void queryClient.invalidateQueries({ queryKey }) }

  useEffect(() => onWorkspaceEvent((name) => {
    if (name === 'automation-change' || name === 'project-added' || name === 'project-removed') refresh()
  }), [queryClient])

  const save = async (
    body: CreateAutomationInput,
    enabled: boolean,
    targetEntryIds: string[],
    current?: WorkspaceScheduleAutomation,
  ) => {
    const schedule = body.schedule
    if (!schedule) throw new Error('Choose a schedule before saving.')
    const definition = { ...body, kind: 'schedule' as const, schedule, targetEntryIds }
    if (current) {
      await updateWorkspaceAutomation(current.id, {
        ...definition, enabled, expectedRevision: current.revision,
      })
    } else {
      await createWorkspaceAutomation({ ...definition, enable: enabled })
    }
    refresh()
  }

  const toggle = async (automation: WorkspaceAutomationEntry) => {
    setBusyId(automation.id)
    setError(undefined)
    try {
      await updateWorkspaceAutomation(automation.id, {
        name: automation.name,
        ...(automation.description ? { description: automation.description } : {}),
        kind: 'schedule', schedule: automation.schedule, task: automation.task,
        targetEntryIds: automation.targetEntryIds,
        enabled: !automation.enabled,
        expectedRevision: automation.revision,
      })
      refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }

  const remove = async (automation: WorkspaceAutomationEntry) => {
    if (!window.confirm(`Delete the workspace schedule “${automation.name}”?`)) return
    setBusyId(automation.id)
    setError(undefined)
    try {
      await deleteWorkspaceAutomation(automation.id)
      refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(undefined)
    }
  }

  if (!data) {
    return <div data-route="workspace-automations" className="p-6 text-sm text-muted-foreground" role={query.isError ? 'alert' : 'status'}>
      {query.isError ? String(query.error) : 'Loading workspace automations…'}
    </div>
  }

  const automation = mode === 'edit' ? data.automations.find(item => item.id === automationId) : undefined
  if (mode !== 'list') {
    if (mode === 'edit' && !automation) return <div className="p-6 text-sm" role="alert">Workspace automation not found.</div>
    const missingTargets = automation ? automation.targetEntryIds.flatMap(targetEntryId => {
      if (data.projects.some(project => project.targetEntryId === targetEntryId)) return []
      const target = automation.targets.find(item => item.targetEntryId === targetEntryId)
      return [{ targetEntryId, projectId: '', name: target?.name ?? 'Removed repository', available: false }]
    }) : []
    return (
      <AutomationEditor
        data={{ timeZone: data.timeZone, available: true }}
        automation={automation}
        workspace={{
          projects: [...data.projects, ...missingTargets],
          targetEntryIds: automation?.targetEntryIds ?? [],
          refresh,
          onSave: save,
        }}
        onBack={() => navigate('/workspace/automations')}
        onSaved={() => navigate('/workspace/automations')}
      />
    )
  }

  return (
    <div data-route="workspace-automations" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-3 border-b border-border bg-background px-5 py-2">
        <div>
          <h1 className="m-0 text-base font-semibold">Workspace automations</h1>
          <p className="m-0 text-xs text-muted-foreground">One scheduled definition, with a separate run and checkpoint in each selected repository.</p>
        </div>
        <span className="flex-1" />
        <Button variant="outline" asChild><Link to="/automations">Project automations</Link></Button>
        <Button asChild><Link to="/workspace/automations/new">New workspace schedule</Link></Button>
      </header>
      {error ? <div className="mx-5 mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
      {query.isError ? <div className="p-5 text-sm text-destructive" role="alert">{String(query.error)}</div> : null}
      {data.automations.length === 0 ? (
        <div className="m-5 rounded-lg border border-dashed border-border p-8 text-center">
          <h2 className="text-sm font-semibold">No workspace schedules yet</h2>
          <p className="text-sm text-muted-foreground">Create one schedule and choose the repositories where it should run.</p>
          <Button asChild><Link to="/workspace/automations/new">Create schedule</Link></Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5">
          {data.automations.map(item => (
            <Card key={item.id} className="gap-0 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="m-0 truncate text-sm font-semibold">{item.name}</h2>
                  <p className="m-0 mt-1 text-xs text-muted-foreground">{scheduleLabel(item.schedule)} · {item.enabled ? 'Enabled' : 'Paused'}</p>
                </div>
                <Switch aria-label={`${item.enabled ? 'Pause' : 'Enable'} ${item.name}`} checked={item.enabled} disabled={busyId === item.id} onCheckedChange={() => void toggle(item)} />
                <Button variant="outline" size="sm" asChild><Link to={`/workspace/automations/${encodeURIComponent(item.id)}`}>Edit</Link></Button>
                <Button variant="ghost" size="sm" disabled={busyId === item.id} onClick={() => void remove(item)}>Delete</Button>
              </div>
              <div className="mt-3">
                {item.targets.map(target => <TargetRow key={target.targetEntryId} target={target} timeZone={data.timeZone} />)}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
