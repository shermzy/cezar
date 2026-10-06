import { Fragment } from 'react'
import { CheckCircle2Icon, CircleDashedIcon, CircleDotIcon } from 'lucide-react'
import type {
  SdlcAudit,
  SdlcPlay,
  SdlcPlayResult,
  SdlcProjectAudit,
  SdlcScore,
  SdlcStage,
} from '@open-mercato/cezar-api-client'

const STAGE_LABEL: Record<SdlcStage, string> = {
  plan: 'Plan',
  design: 'Design',
  build: 'Build',
  test: 'Test',
  deploy: 'Deploy',
  maintain: 'Maintain',
}

const SCORE_LABEL: Record<SdlcScore, string> = { present: 'Present', partial: 'Partial', absent: 'Absent' }

const BASELINE_LABEL = {
  none: 'No baseline',
  current: 'Baseline current',
  outdated: 'Baseline outdated',
  diverged: 'Baseline edited',
} as const

export interface SdlcSelection {
  projectId: string
  play: SdlcPlay['id']
}

/** A score is a glyph AND a word (aria-label + shape), never colour alone. */
function ScoreMark({ score }: { score: SdlcScore }) {
  if (score === 'present')
    return <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
  if (score === 'partial')
    return <CircleDotIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
  return <CircleDashedIcon className="size-4 text-soft-foreground" aria-hidden="true" />
}

/** Plays grouped by stage, in catalog order, so the header can span each stage. */
export function stageGroups(plays: readonly SdlcPlay[]): Array<{ stage: SdlcStage; plays: SdlcPlay[] }> {
  const groups: Array<{ stage: SdlcStage; plays: SdlcPlay[] }> = []
  for (const stage of Object.keys(STAGE_LABEL) as SdlcStage[]) {
    const inStage = plays.filter((p) => p.stage === stage)
    if (inStage.length > 0) groups.push({ stage, plays: inStage })
  }
  return groups
}

export function fleetCount(audit: SdlcAudit, play: SdlcPlay['id']) {
  const scanned = audit.projects.filter((p) => p.status === 'ok')
  const present = scanned.filter((p) => p.results.find((r) => r.play === play)?.score === 'present').length
  return { present, scanned: scanned.length }
}

export function SdlcMatrix({
  audit,
  selection,
  onSelect,
  picked,
  onPick,
  canAdopt,
}: {
  audit: SdlcAudit
  selection: SdlcSelection | null
  onSelect: (next: SdlcSelection | null) => void
  picked: ReadonlySet<string>
  onPick: (projectId: string, on: boolean) => void
  canAdopt: boolean
}) {
  const groups = stageGroups(audit.plays)
  const ordered = groups.flatMap((g) => g.plays)
  const resultFor = (project: SdlcProjectAudit, play: SdlcPlay['id']): SdlcPlayResult | undefined =>
    project.results.find((r) => r.play === play)
  const titleOf = (id: SdlcPlay['id']) => audit.plays.find((p) => p.id === id)?.title ?? id

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          AI-native SDLC coverage: each row is a project, each column a play. Select a cell to see its evidence.
        </caption>
        <thead>
          <tr>
            <th rowSpan={2} scope="col" className="sticky left-0 z-10 min-w-56 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
              Project
            </th>
            {groups.map((g) => (
              <th key={g.stage} scope="colgroup" colSpan={g.plays.length} className="border-l px-2 py-1 text-center text-[11px] font-medium uppercase tracking-wide text-soft-foreground">
                {STAGE_LABEL[g.stage]}
              </th>
            ))}
          </tr>
          <tr>
            {ordered.map((p) => (
              <th key={p.id} scope="col" className="max-w-24 border-l px-2 py-1 text-center align-bottom text-[11px] font-normal leading-tight text-muted-foreground">
                {p.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {audit.projects.map((project) => {
            const scanned = project.status === 'ok'
            const next = project.next ? titleOf(project.next) : null
            return (
              <tr key={project.projectId} className={`border-t ${scanned ? '' : 'opacity-60'}`}>
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                  <div className="flex items-start gap-2">
                    {canAdopt && (
                      <input
                        type="checkbox"
                        className="mt-1 size-4"
                        aria-label={`Select ${project.name} for baseline adoption`}
                        checked={picked.has(project.projectId)}
                        disabled={!scanned}
                        onChange={(e) => onPick(project.projectId, e.target.checked)}
                      />
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{project.name}</div>
                      {scanned ? (
                        <div className="text-xs text-muted-foreground">
                          {BASELINE_LABEL[project.baseline.state]}
                          {next ? ` · next: ${next}` : ' · all plays present'}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          {project.status === 'missing' ? 'Project folder unavailable' : 'Not a git repository'}
                        </div>
                      )}
                    </div>
                  </div>
                </th>
                {ordered.map((play) => {
                  const result = resultFor(project, play.id)
                  if (!result) return <td key={play.id} className="border-l px-2 py-2 text-center text-soft-foreground">–</td>
                  const active = selection?.projectId === project.projectId && selection.play === play.id
                  return (
                    <td key={play.id} className="border-l px-1 py-1 text-center">
                      <button
                        type="button"
                        aria-label={`${project.name}, ${play.title}: ${SCORE_LABEL[result.score]}`}
                        aria-pressed={active}
                        onClick={() => onSelect(active ? null : { projectId: project.projectId, play: play.id })}
                        className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${active ? 'bg-muted ring-1 ring-ring' : ''}`}
                      >
                        <ScoreMark score={result.score} />
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t">
            <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
              Fleet
            </th>
            {ordered.map((p) => {
              const { present, scanned } = fleetCount(audit, p.id)
              return (
                <td key={p.id} className="border-l px-2 py-2 text-center font-mono text-[11px] text-muted-foreground">
                  <Fragment>
                    {present}/{scanned}
                  </Fragment>
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** What justifies the selected cell: the score, the note, and the files behind it. */
export function SdlcEvidence({ audit, selection }: { audit: SdlcAudit; selection: SdlcSelection | null }) {
  const project = selection ? audit.projects.find((p) => p.projectId === selection.projectId) : undefined
  const play = selection ? audit.plays.find((p) => p.id === selection.play) : undefined
  const result = project && selection ? project.results.find((r) => r.play === selection.play) : undefined
  return (
    <section aria-live="polite" aria-label="Evidence" className="border-t px-3 py-3 text-sm">
      {!project || !play || !result ? (
        <p className="text-muted-foreground">Select a cell to see what the score is based on.</p>
      ) : (
        <>
          <p className="font-medium">
            {project.name} · {play.title}: {SCORE_LABEL[result.score]}
          </p>
          {result.note && <p className="mt-1 text-muted-foreground">{result.note}</p>}
          {result.evidence.length > 0 ? (
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              {result.evidence.map((path) => (
                <li key={path} className="break-all">
                  {path}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-muted-foreground">Nothing found for this play.</p>
          )}
          {play.prereqs.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Builds on: {play.prereqs.map((id) => audit.plays.find((p) => p.id === id)?.title ?? id).join(', ')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
