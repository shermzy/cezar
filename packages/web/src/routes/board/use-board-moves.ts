import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { CreateRunInput } from '@open-mercato/cezar-api-client'
import {
  cancelProjectAutoResume,
  cancelProjectRun,
  createProjectRun,
  finishProjectRun,
  getAgentProfiles,
  getProjectConfig,
  getProjectRun,
} from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { AttentionInput } from '@/lib/attention'
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, boardColumn, type BoardColumnId } from '@/lib/board-columns'
import { moveIntent, type BoardAction } from '@/lib/board-moves'
import { rerunBody } from '@/lib/rerun-body'
import { runTitle, type RunTitleInput } from '@/lib/task-groups'

/** What an action needs of a card: which run, what it is called, and what its column reads. */
export type ActionRun = RunTitleInput & AttentionInput & { id: string; projectId?: string }

/** The confirm dialog's state: the run, the action it names, and what the dialog must also say. */
export interface MoveDialog {
  run: ActionRun
  projectId: string
  action: BoardAction
  /** Run again only: the `POST /runs` body `rerunBody` built, shown before it is sent. */
  body?: CreateRunInput
  /** Extra sentences for this run: dispatched tasks a cancel takes along; what a re-run drops. */
  notes: string[]
}

/** A confirmed action waiting for its card to leave the column it was confirmed in. */
interface Pending {
  action: BoardAction
  column: BoardColumnId
  title: string
}

/** Where each action sends a card — the column a drop on it came from, or the menu's equivalent. */
const TARGET: Record<BoardAction, BoardColumnId> = {
  accept: 'done',
  finish: 'done',
  cancel: 'not-doing',
  'stop-resume': 'done',
  rerun: 'queued',
}

/** The live region's words once a card has moved. */
const LANDED: Record<BoardAction, string> = {
  accept: 'Accepted',
  finish: 'Finished',
  cancel: 'Cancelled',
  'stop-resume': 'Stopped resuming',
  rerun: 'Started again',
}

/** Long enough for any real transition; short enough that a stuck "cancelling…" heals itself. */
const PENDING_TTL_MS = 30_000

/**
 * The Board's confirmed moves (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c): ask → the
 * dialog names the effect → confirm → the route. Shared by both boards, which act through the
 * project-explicit client calls (`projectIdOf` names each card's project).
 *
 * - **Nothing moves optimistically.** A confirmed card is `pending` — dimmed, its label saying what
 *   it waits for — while it is still drawn in the column it was confirmed in. It clears when the
 *   card lands in another column (`observe`, which each board area calls with its columns), on an
 *   error, or after 30 s. Keyed on the COLUMN, not the status: stopping a scheduled resume leaves
 *   the run `failed` and only its column changes. A re-run's card never moves; its pending clears
 *   when `POST /runs` answers.
 * - **Confirm re-reads the run.** The dialog may have stood open while the agent moved on (a run
 *   that was running is waiting now). Confirm fetches the record and re-derives `moveIntent`; if
 *   the action is no longer the one the dialog named, nothing is sent and a toast says why.
 * - **A landed card is announced** in a polite live region, and if focus went with the old card
 *   (it unmounted), the moved card's ⋯ button takes it.
 * - Every failure is a danger toast in the server's own words, and the card stays put.
 */
export function useBoardMoves(projectIdOf: (run: { id: string; projectId?: string }) => string) {
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<MoveDialog | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // The ref is the truth (so `observe`, called from effects, never reads a stale map); the state
  // only re-renders the cards.
  const pendingRef = useRef<ReadonlyMap<string, Pending>>(new Map())
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(pendingRef.current)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const live = timers.current
    return () => {
      for (const timer of live) clearTimeout(timer)
    }
  }, [])

  const keyOf = (projectId: string, runId: string) => `${projectId}/${runId}`

  const publish = useCallback((next: ReadonlyMap<string, Pending>) => {
    pendingRef.current = next
    setPending(next)
  }, [])

  const clear = useCallback(
    (key: string) => {
      if (!pendingRef.current.has(key)) return
      const next = new Map(pendingRef.current)
      next.delete(key)
      publish(next)
    },
    [publish],
  )

  const mark = useCallback(
    (key: string, entry: Pending) => {
      publish(new Map(pendingRef.current).set(key, entry))
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        clear(key)
      }, PENDING_TTL_MS)
      timers.current.add(timer)
    },
    [clear, publish],
  )

  /** Every run list (any project scope, `[scope, 'runs', …]`) and the cross-project index. The
   *  stream patches them anyway; this covers a dropped event. */
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === 'runs' })
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
  }, [queryClient])

  /** The run as the server has it now — `staleTime: 0`, the cache is what may be stale. */
  const fetchRecord = useCallback(
    (projectId: string, runId: string) =>
      queryClient.fetchQuery({
        queryKey: [projectId, 'runs', 'detail', runId] as const,
        queryFn: ({ signal }) => getProjectRun(projectId, runId, { signal }),
        staleTime: 0,
      }),
    [queryClient],
  )

  /** Open the confirm dialog for `action` — for a re-run, after building its body from the FULL
   *  record (an index row carries no task text) and the project's own config and accounts. */
  const request = useCallback(
    async (run: ActionRun, action: BoardAction) => {
      const projectId = projectIdOf(run)
      if (action !== 'rerun') {
        // `cancel` cascades down a dispatch tree (`run.ts`, `cancelDescendants`).
        const notes = action === 'cancel' && run.dispatch ? ['Any tasks it dispatched are cancelled too.'] : []
        setDialog({ run, projectId, action, notes })
        return
      }
      try {
        const [record, config, accounts] = await Promise.all([
          fetchRecord(projectId, run.id),
          queryClient.fetchQuery({
            queryKey: [projectId, 'config'] as const,
            queryFn: ({ signal }) => getProjectConfig(projectId, { signal }),
          }),
          queryClient.fetchQuery({
            queryKey: workspaceQueryKeys.agentProfiles,
            queryFn: ({ signal }) => getAgentProfiles({ signal }),
          }),
        ])
        const rerun = rerunBody(record, {
          modelsLocked: config.modelsLocked,
          defaultRunner: config.defaultRunner,
          profiles: accounts.profiles,
        })
        if (!rerun.ok) {
          toast(rerun.reason, { tone: 'danger' })
          return
        }
        const notes: string[] = []
        if (rerun.dropped.model !== undefined) {
          notes.push(`The model “${rerun.dropped.model}” is not copied: this project's models are locked.`)
        }
        if (rerun.dropped.account !== undefined) {
          const label = accounts.profiles.find((profile) => profile.id === rerun.dropped.account)?.label ?? rerun.dropped.account
          notes.push(`The account “${label}” is not copied: its agent no longer has it, so the new task uses the project's account.`)
        }
        setDialog({ run, projectId, action, body: rerun.body, notes })
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      }
    },
    [fetchRecord, projectIdOf, queryClient],
  )

  /** The dialog's confirm button: re-check the action against the LIVE run, send the route, and
   *  mark the card pending until it leaves its column. */
  const confirm = useCallback(async () => {
    if (!dialog) return
    const { run, projectId, action, body } = dialog
    setDialog(null)
    const key = keyOf(projectId, run.id)
    try {
      const live = await fetchRecord(projectId, run.id)
      const from = boardColumn(live)
      const now = moveIntent(from, TARGET[action], live)
      if (now.kind !== 'action' || now.action !== action) {
        toast(`“${runTitle(run)}” changed while you were deciding — it is in ${BOARD_COLUMN_LABELS[from]} now — so nothing was done.`)
        return
      }
      mark(key, { action, column: from, title: runTitle(run) })
      if (action === 'accept' || action === 'finish') {
        await finishProjectRun(projectId, run.id)
      } else if (action === 'cancel') {
        // `{ cancelled: false }` is a 200: the run was neither queued nor running any more.
        const { cancelled } = await cancelProjectRun(projectId, run.id)
        if (!cancelled) {
          clear(key)
          toast(`Nothing to cancel — “${runTitle(run)}” had already stopped.`, { tone: 'danger' })
        }
      } else if (action === 'stop-resume') {
        await cancelProjectAutoResume(projectId, run.id)
      } else if (body) {
        await createProjectRun(projectId, body)
        // The new task is a new card; the old one never moves, so nothing is left to wait for.
        clear(key)
        toast(`Started “${runTitle(run)}” again as a new task.`)
      }
    } catch (error) {
      clear(key)
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      refresh()
    }
  }, [clear, dialog, fetchRecord, mark, refresh])

  /**
   * Called by each board area after it renders its columns (in an effect): every pending card of
   * that project that is now drawn in ANOTHER column has landed. It stops being pending, the live
   * region says where it went, and — if the old card took the focus with it when it unmounted —
   * the moved card's ⋯ button gets it back.
   */
  const observe = useCallback(
    (projectId: string, columns: Record<BoardColumnId, readonly { id: string }[]>) => {
      const prefix = `${projectId}/`
      let landed: { key: string; runId: string; column: BoardColumnId; entry: Pending } | undefined
      const next = new Map(pendingRef.current)
      for (const [key, entry] of pendingRef.current) {
        if (!key.startsWith(prefix)) continue
        const runId = key.slice(prefix.length)
        const column = BOARD_COLUMNS.find((id) => columns[id].some((run) => run.id === runId))
        if (column === undefined || column === entry.column) continue
        next.delete(key)
        landed = { key, runId, column, entry }
      }
      if (!landed) return
      publish(next)
      setAnnouncement(`${LANDED[landed.entry.action]} “${landed.entry.title}” — moved to ${BOARD_COLUMN_LABELS[landed.column]}.`)
      const { runId } = landed
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (active && active !== document.body) return
        const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(runId) : runId
        document
          .querySelector<HTMLElement>(`[data-slot="board-card-shell"][data-run-id="${id}"] [data-slot="board-card-menu"]`)
          ?.focus()
      })
    },
    [publish],
  )

  /** The action a card is visibly waiting on — only while it is still drawn in the column the
   *  action was confirmed in. */
  const pendingFor = useCallback(
    (run: AttentionInput & { id: string; projectId?: string }): BoardAction | undefined => {
      const entry = pending.get(keyOf(projectIdOf(run), run.id))
      return entry && entry.column === boardColumn(run) ? entry.action : undefined
    },
    [pending, projectIdOf],
  )

  return { dialog, request, confirm, dismiss: () => setDialog(null), pendingFor, observe, announcement }
}

export type BoardMoves = ReturnType<typeof useBoardMoves>
