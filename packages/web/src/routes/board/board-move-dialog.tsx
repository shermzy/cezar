import { EllipsisIcon } from 'lucide-react'

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { BoardAction } from '@/lib/board-moves'
import { runTitle } from '@/lib/task-groups'

import type { BoardMoves } from './use-board-moves'

/**
 * What each confirmed move does, in the words the dialog uses (spec
 * `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Moving cards: "a dialog that names the
 * effect"). `destructive` paints the confirm button danger.
 */
const COPY: Record<BoardAction, { title: string; effect: string; confirm: string; menu: string; destructive: boolean }> = {
  accept: {
    title: 'Accept the changes?',
    effect: 'The task completes as done, without opening a pull request. Its branch and worktree stay.',
    confirm: 'Accept',
    menu: 'Accept…',
    destructive: false,
  },
  finish: {
    title: 'Finish this task?',
    effect:
      "The agent's session closes and the task completes as done — or waits in Review, when the review gate is on and it changed files.",
    confirm: 'Finish',
    menu: 'Finish…',
    destructive: false,
  },
  cancel: {
    title: 'Cancel this task?',
    effect: 'The agent is stopped and the task completes as cancelled. The worktree stays.',
    confirm: 'Cancel the task',
    menu: 'Cancel…',
    destructive: true,
  },
  'stop-resume': {
    title: 'Stop the automatic resume?',
    effect:
      "This task won't resume on its own when the usage limit resets. It stays failed, in Done; you can still continue it from its page.",
    confirm: 'Stop resuming',
    menu: 'Stop resuming…',
    destructive: true,
  },
  rerun: {
    title: 'Run this again as a new task?',
    effect:
      'A new task starts with the same prompt, workflow, agent and settings; this one stays as it is. Attachments are not copied.',
    confirm: 'Run again',
    menu: 'Run again…',
    destructive: false,
  },
}

/**
 * The one confirm dialog both boards share — never a native `confirm()` (design guardian) — and the
 * polite live region that says where a confirmed card landed (`moves.announcement`). The region is
 * always mounted, so a screen reader is already listening when the text changes.
 */
export function BoardMoveDialog({ moves }: { moves: BoardMoves }) {
  const { dialog } = moves
  const copy = dialog ? COPY[dialog.action] : null
  return (
    <>
      <p data-slot="board-move-announcer" role="status" aria-live="polite" className="sr-only">
        {moves.announcement}
      </p>
      <AlertDialog open={dialog !== null} onOpenChange={(open) => !open && moves.dismiss()}>
        {dialog && copy ? (
          <AlertDialogContent data-slot="board-move-dialog" data-action={dialog.action}>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.effect}
                {dialog.notes.map((note) => (
                  <span key={note} data-slot="board-move-note" className="mt-1 block">
                    {note}
                  </span>
                ))}
                <span className="mt-1 block truncate font-medium text-foreground" title={runTitle(dialog.run)}>
                  {runTitle(dialog.run)}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-slot="board-move-keep">Keep it</AlertDialogCancel>
              <AlertDialogAction
                data-slot="board-move-confirm"
                className={copy.destructive ? 'bg-danger text-danger-foreground hover:brightness-[0.96]' : undefined}
                onClick={() => void moves.confirm()}
              >
                {copy.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  )
}

/**
 * A card's ⋯ menu: the same actions a drop would ask for (`cardActions`), with the same dialog.
 * It is the keyboard-light and phone path — dragging is off below `md`.
 */
export function BoardCardMenu({
  title,
  actions,
  onSelect,
}: {
  title: string
  actions: readonly BoardAction[]
  onSelect: (action: BoardAction) => void
}) {
  if (actions.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="board-card-menu"
          aria-label={`Actions for ${title}`}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <EllipsisIcon className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action}
            data-slot="board-card-action"
            data-action={action}
            variant={COPY[action].destructive ? 'destructive' : 'default'}
            onSelect={() => onSelect(action)}
          >
            {COPY[action].menu}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}