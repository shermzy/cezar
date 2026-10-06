import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SdlcBaselineApply, SdlcBaselinePlan } from '@open-mercato/cezar-api-client'
import { applySdlcBaseline, planSdlcBaseline, sdlcKeys, useSdlcAudit } from '@/api/sdlc'
import { useHostTransport } from '@/api/host-usage'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SdlcEvidence, SdlcMatrix, type SdlcSelection } from './sdlc-matrix'
import { widgetHeader, widgetHeading } from './presentation'

const ACTION_LABEL = {
  create: 'will create',
  update: 'will update',
  'skip-diverged': 'edited here, left alone',
  'skip-current': 'already current',
} as const

/**
 * Fleet view of the AI-native SDLC (spec 2026-10-06-ai-native-sdlc-fleet): a project × play
 * matrix from a deterministic scan, and "Adopt baseline" for the projects you pick. Adoption
 * only ever starts an ordinary task per project — it ends at that task's review gate.
 */
export function SdlcView() {
  const audit = useSdlcAudit()
  const client = useQueryClient()
  const transport = useHostTransport()
  const canAdopt = transport === 'local'
  const [selection, setSelection] = useState<SdlcSelection | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [plan, setPlan] = useState<SdlcBaselinePlan | null>(null)
  const [started, setStarted] = useState<SdlcBaselineApply | null>(null)

  const planMutation = useMutation({ mutationFn: planSdlcBaseline, onSuccess: setPlan })
  const applyMutation = useMutation({
    mutationFn: applySdlcBaseline,
    onSuccess: (result) => {
      setStarted(result)
      setPlan(null)
      setPicked(new Set())
      void client.invalidateQueries({ queryKey: sdlcKeys.audit })
    },
  })

  const ids = [...picked]
  const nameOf = (id: string) => audit.data?.projects.find((p) => p.projectId === id)?.name ?? id
  const writes = plan?.projects.reduce((n, p) => n + p.files.filter((f) => f.action === 'create' || f.action === 'update').length, 0) ?? 0

  return (
    <Card className="min-w-0 gap-0 py-0">
      <div className={widgetHeader}>
        <h2 className={widgetHeading}>AI-native SDLC</h2>
        <div className="flex items-center gap-2">
          {audit.data && (
            <span className="font-mono text-[11px] text-soft-foreground">baseline v{audit.data.baselineVersion}</span>
          )}
          <Button variant="outline" className="min-h-11" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
            {audit.isFetching ? 'Scanning…' : 'Rescan'}
          </Button>
          {canAdopt && (
            <Button className="min-h-11" disabled={ids.length === 0 || planMutation.isPending} onClick={() => planMutation.mutate(ids)}>
              Adopt baseline{ids.length > 0 ? ` (${ids.length})` : ''}
            </Button>
          )}
        </div>
      </div>

      {audit.isPending && <p role="status" className="px-3 py-4 text-sm text-muted-foreground">Scanning projects…</p>}
      {audit.isError && (
        <p role="alert" className="px-3 py-4 text-sm">
          Could not scan projects. <Button className="min-h-11" onClick={() => void audit.refetch()}>Retry</Button>
        </p>
      )}
      {planMutation.isError && (
        <p role="alert" className="px-3 py-2 text-sm">
          Could not plan the baseline: {planMutation.error instanceof Error ? planMutation.error.message : 'unknown error'}
        </p>
      )}
      {audit.data && audit.data.projects.length === 0 && (
        <p className="px-3 py-4 text-sm text-muted-foreground">No projects are registered yet.</p>
      )}
      {audit.data && audit.data.projects.length > 0 && (
        <>
          <SdlcMatrix
            audit={audit.data}
            selection={selection}
            onSelect={setSelection}
            picked={picked}
            onPick={(id, on) =>
              setPicked((prev) => {
                const next = new Set(prev)
                if (on) next.add(id)
                else next.delete(id)
                return next
              })
            }
            canAdopt={canAdopt}
          />
          <SdlcEvidence audit={audit.data} selection={selection} />
        </>
      )}

      {started && (
        <section aria-label="Baseline tasks" className="border-t px-3 py-3 text-sm">
          <p className="font-medium">Baseline tasks started</p>
          <p className="text-xs text-muted-foreground">Each runs in its own worktree and stops at review. Nothing is merged.</p>
          <ul className="mt-2 space-y-1">
            {started.runs.map((r) => (
              <li key={r.projectId}>
                {'runId' in r ? (
                  <Link className="underline underline-offset-2" to={`/p/${encodeURIComponent(r.projectId)}/tasks/${encodeURIComponent(r.runId)}`}>
                    {nameOf(r.projectId)}: open the task
                  </Link>
                ) : (
                  <span role="alert">{nameOf(r.projectId)}: {r.error}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog open={plan !== null} onOpenChange={(open) => { if (!open) setPlan(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adopt the SDLC baseline</DialogTitle>
            <DialogDescription>
              {writes === 0
                ? 'Nothing to write: every selected project is already current or has its own versions of these files.'
                : `One task per project writes ${writes} file${writes === 1 ? '' : 's'} into its own worktree and stops at review. A file that already exists is never edited.`}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-3 overflow-y-auto text-sm">
            {plan?.projects.map((p) => (
              <div key={p.projectId}>
                <p className="font-medium">{nameOf(p.projectId)}</p>
                <ul className="font-mono text-xs">
                  {p.files.map((f) => (
                    <li key={f.path} className="flex justify-between gap-3">
                      <span className="break-all">{f.path}</span>
                      <span className="shrink-0 text-muted-foreground">{ACTION_LABEL[f.action]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {applyMutation.isError && (
            <p role="alert" className="text-sm">
              Could not start the tasks: {applyMutation.error instanceof Error ? applyMutation.error.message : 'unknown error'}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setPlan(null)}>Cancel</Button>
            <Button className="min-h-11" disabled={writes === 0 || applyMutation.isPending} onClick={() => applyMutation.mutate(ids)}>
              {applyMutation.isPending ? 'Starting…' : `Start ${ids.length} task${ids.length === 1 ? '' : 's'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
