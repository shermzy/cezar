import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import {
  createWorkspaceSpecialist,
  deleteWorkspaceSpecialist,
  updateWorkspaceSpecialist,
} from '@/api/client'
import { useProjects, useRunsIndex, useWorkspaceSpecialists, workspaceQueryKeys } from '@/api/queries'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import type {
  RunIndexEntry,
  SpecialistCreate,
  SpecialistDefinition,
  SpecialistUpdate,
} from '@open-mercato/cezar-api-client'

type RoleDraft = { id?: string; name: string; description: string; instructions: string }
type HandoffDraft = { role: SpecialistDefinition; run: RunIndexEntry }

function assignmentState(runs: RunIndexEntry[]): string {
  if (runs.some((run) => ['failed', 'waiting', 'review'].includes(run.status))) return 'Needs attention'
  if (runs.some((run) => ['queued', 'running'].includes(run.status))) return 'Working'
  return 'Standby'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AgentsRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const projectsQuery = useProjects()
  const rolesQuery = useWorkspaceSpecialists()
  const indexQuery = useRunsIndex()
  const [editor, setEditor] = useState<RoleDraft | null>(null)
  const [deletingRole, setDeletingRole] = useState<SpecialistDefinition | null>(null)
  const [handoff, setHandoff] = useState<HandoffDraft | null>(null)
  const [handoffTarget, setHandoffTarget] = useState('')
  const [handoffNote, setHandoffNote] = useState('')

  const refreshRoles = () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.specialists })
  const saveRole = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: SpecialistCreate | SpecialistUpdate }) =>
      id
        ? updateWorkspaceSpecialist(id, input as SpecialistUpdate)
        : createWorkspaceSpecialist(input as SpecialistCreate),
    onSuccess: () => {
      void refreshRoles()
      setEditor(null)
      toast('Specialist saved.')
    },
    onError: (error) => toast(errorMessage(error), { tone: 'danger' }),
  })
  const removeRole = useMutation({
    mutationFn: deleteWorkspaceSpecialist,
    onSuccess: () => {
      void refreshRoles()
      toast('Specialist removed. Existing runs keep their saved role instructions.')
    },
    onError: (error) => toast(errorMessage(error), { tone: 'danger' }),
  })

  const roles = rolesQuery.data?.specialists ?? []
  const projects = (projectsQuery.data?.projects ?? []).filter((project) => project.status !== 'missing')
  const runs = indexQuery.data?.runs ?? []

  const editRole = (role: SpecialistDefinition) =>
    setEditor({ name: role.name, description: role.description, instructions: role.instructions })
  const cloneRole = (role: SpecialistDefinition) =>
    setEditor({ name: `${role.name} copy`, description: role.description, instructions: role.instructions })

  const submitRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editor) return
    const input = {
      name: editor.name,
      description: editor.description,
      instructions: editor.instructions,
    }
    saveRole.mutate({ id: editor.id, input })
  }

  const beginHandoff = (role: SpecialistDefinition, run: RunIndexEntry) => {
    const target = projects.find((project) => project.id !== run.projectId)?.id ?? ''
    setHandoff({ role, run })
    setHandoffTarget(target)
    setHandoffNote('')
  }

  const continueHandoff = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!handoff || !handoffTarget || !handoffNote.trim()) return
    const sourcePath = `/p/${encodeURIComponent(handoff.run.projectId)}/tasks/${encodeURIComponent(handoff.run.id)}`
    const taskText = `${handoffNote.trim()}\n\nSource task link: ${window.location.origin}${sourcePath}`
    navigate(`/p/${encodeURIComponent(handoffTarget)}/new?specialist=${encodeURIComponent(handoff.role.id)}`, {
      state: {
        specialistHandoff: {
          note: taskText,
          sourceProjectId: handoff.run.projectId,
          sourceRunId: handoff.run.id,
        },
      },
    })
  }

  return (
    <div data-route="agents" className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-6 py-8 max-md:px-4 max-md:py-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Workspace roster</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Keep specialist roles ready across projects. They stay idle until you assign a task.
          </p>
        </div>
        <Button onClick={() => setEditor({ name: '', description: '', instructions: '' })}>
          Create specialist
        </Button>
      </header>

      <aside className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-xs leading-5 text-muted-foreground">
        Role instructions guide the task prompt. Project access, provider account, tools, model, worktree,
        and review policy still come from the selected project's normal run settings.
      </aside>

      {editor && (
        <form onSubmit={submitRole} className="grid gap-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">{editor.id ? 'Edit specialist' : 'New specialist'}</h2>
              <p className="mt-1 text-sm text-muted-foreground">Instructions are saved as a snapshot when a task starts.</p>
            </div>
            <Button type="button" variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Name
            <input
              autoFocus
              required
              maxLength={80}
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Description
            <input
              maxLength={400}
              value={editor.description}
              onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Instructions
            <Textarea
              required
              maxLength={8_000}
              rows={5}
              value={editor.instructions}
              onChange={(event) => setEditor({ ...editor, instructions: event.target.value })}
              className="resize-y text-sm font-normal"
            />
          </label>
          <div>
            <Button type="submit" disabled={saveRole.isPending}>
              {saveRole.isPending ? 'Saving…' : 'Save specialist'}
            </Button>
          </div>
        </form>
      )}

      {rolesQuery.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">Loading specialists…</p>
      ) : rolesQuery.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{errorMessage(rolesQuery.error)}</p>
      ) : (
        <section aria-label="Specialist roles" className="grid gap-4 xl:grid-cols-2">
          {roles.map((role) => {
            const roleRuns = runs.filter((run) => run.specialist?.id === role.id)
            return (
              <article key={role.id} id={`specialist-${role.id}`} data-specialist-id={role.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{role.name}</h2>
                      <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {role.builtIn ? 'Built in' : 'Custom'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{role.description || 'No description yet.'}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => cloneRole(role)}>Clone</Button>
                    {!role.builtIn && <Button variant="outline" size="sm" onClick={() => editRole(role)}>Edit</Button>}
                    {!role.builtIn && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeletingRole(role)}
                        disabled={removeRole.isPending}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid gap-3">
                  {projects.map((project) => {
                    const projectRuns = roleRuns
                      .filter((run) => run.projectId === project.id)
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    const status = assignmentState(projectRuns)
                    return (
                      <section key={project.id} data-project-assignment={`${role.id}:${project.id}`} className="rounded-lg bg-muted/35 px-3.5 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate text-sm font-medium">{project.name}</h3>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {status}{projectRuns.length ? ` · ${projectRuns.length} indexed run${projectRuns.length === 1 ? '' : 's'}` : ''}
                            </p>
                          </div>
                          <Link
                            data-role-assignment={role.id}
                            to={`/p/${encodeURIComponent(project.id)}/new?specialist=${encodeURIComponent(role.id)}`}
                            className="inline-flex h-8 items-center rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            Assign task
                          </Link>
                        </div>
                        {projectRuns.slice(0, 4).map((run) => (
                          <div key={run.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-xs">
                            <Link to={`/p/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(run.id)}`} className="min-w-0 truncate text-foreground underline-offset-4 hover:underline">
                              {run.titleSummary ?? run.title}
                            </Link>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span>{run.status}</span>
                              {projects.some((entry) => entry.id !== project.id) && (
                                <button
                                  type="button"
                                  className="font-medium text-foreground underline underline-offset-4"
                                  onClick={() => beginHandoff(role, run)}
                                >
                                  Handoff
                                </button>
                              )}
                            </div>
                            {handoff?.run.id === run.id && handoff.run.projectId === project.id && (
                              <form onSubmit={continueHandoff} className="mt-2 grid w-full gap-2 rounded-md border border-border bg-background p-3">
                                <label className="grid gap-1 text-xs font-medium">
                                  Target project
                                  <select
                                    required
                                    value={handoffTarget}
                                    onChange={(event) => setHandoffTarget(event.target.value)}
                                    className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                  >
                                    {projects.filter((entry) => entry.id !== run.projectId).map((target) => (
                                      <option key={target.id} value={target.id}>{target.name}</option>
                                    ))}
                                  </select>
                                </label>
                                <label className="grid gap-1 text-xs font-medium">
                                  Handoff note
                                  <Textarea
                                    required
                                    rows={3}
                                    value={handoffNote}
                                    onChange={(event) => setHandoffNote(event.target.value)}
                                    placeholder="Write exactly what the next project should know."
                                  />
                                </label>
                                <div className="flex flex-wrap gap-2">
                                  <Button type="submit" size="sm" disabled={!handoffTarget || !handoffNote.trim()}>
                                    Review handoff in composer
                                  </Button>
                                  <Button type="button" variant="ghost" size="sm" onClick={() => setHandoff(null)}>Cancel</Button>
                                </div>
                              </form>
                            )}
                          </div>
                        ))}
                      </section>
                    )
                  })}
                  {projects.length === 0 && <p className="text-sm text-muted-foreground">No available projects are registered.</p>}
                  {indexQuery.isError && <p role="status" className="text-xs text-muted-foreground">Assignment status could not be loaded.</p>}
                </div>
              </article>
            )
          })}
        </section>
      )}
      <AlertDialog
        open={deletingRole !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingRole(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletingRole?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the specialist from the workspace. Existing runs keep their saved role instructions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => {
                if (deletingRole) removeRole.mutate(deletingRole.id)
                setDeletingRole(null)
              }}
            >
              Delete specialist
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
