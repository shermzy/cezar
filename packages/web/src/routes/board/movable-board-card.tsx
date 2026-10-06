import type { ReactNode } from 'react'

import { agentSummary, type AccountRow, type AgentSummaryInput } from '@/lib/agent-summary'
import type { BoardColumnId } from '@/lib/board-columns'
import { cardActions } from '@/lib/board-moves'
import { runTitle } from '@/lib/task-groups'

import { BoardCard, type BoardCardRun } from './board-card'
import { BoardCardMenu } from './board-move-dialog'
import type { BoardMoves } from './use-board-moves'

/** What both boards pass for the card's agent line: the project's default runner where the page
 *  holds it (the per-project board), and the account list for labels. */
export interface AgentLineOptions {
  defaultRunner?: string
  profiles?: readonly AccountRow[]
}

/**
 * A card as both boards draw it: the agent line (`agentSummary`), the ⋯ menu with the column's
 * actions, the pending state of a confirmed action, and the drag handle `ColumnCards` passes in.
 */
export function MovableBoardCard<T extends BoardCardRun & AgentSummaryInput & { projectId?: string }>({
  run,
  column,
  handle,
  now,
  moves,
  agentLine,
}: {
  run: T
  column: BoardColumnId
  handle: ReactNode
  now: number
  moves: BoardMoves
  agentLine: AgentLineOptions
}) {
  return (
    <BoardCard
      run={run}
      now={now}
      agent={agentSummary(run, agentLine)?.text}
      handle={handle}
      pending={moves.pendingFor(run)}
      menu={
        <BoardCardMenu
          title={runTitle(run)}
          actions={cardActions(column, run)}
          onSelect={(action) => void moves.request(run, action)}
        />
      }
    />
  )
}