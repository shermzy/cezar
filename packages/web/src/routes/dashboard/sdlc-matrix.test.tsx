import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SdlcAudit } from '@open-mercato/cezar-api-client'
import { SdlcEvidence, SdlcMatrix, fleetCount, stageGroups, type SdlcSelection } from './sdlc-matrix'

afterEach(cleanup)

const plays: SdlcAudit['plays'] = [
  { id: 'intent', stage: 'plan', title: 'Capture as intent.md', prereqs: [] },
  { id: 'claude-md', stage: 'build', title: 'CLAUDE.md', prereqs: [] },
  { id: 'skills', stage: 'build', title: 'Skills', prereqs: [] },
]

const audit: SdlcAudit = {
  baselineVersion: 1,
  plays,
  projects: [
    {
      projectId: 'alpha',
      name: 'Alpha',
      status: 'ok',
      scannedAt: '2026-10-06T10:00:00.000Z',
      results: [
        { play: 'intent', score: 'absent', evidence: [] },
        { play: 'claude-md', score: 'partial', evidence: ['CLAUDE.md'], note: 'CLAUDE.md is 212 lines (aim for under 150)' },
        { play: 'skills', score: 'present', evidence: ['.claude/skills/a/SKILL.md', '.claude/skills/b/SKILL.md'] },
      ],
      baseline: { state: 'outdated', version: 1, files: [] },
      next: 'intent',
    },
    {
      projectId: 'gone',
      name: 'Gone',
      status: 'missing',
      scannedAt: '2026-10-06T10:00:00.000Z',
      results: [],
      baseline: { state: 'none', files: [] },
    },
  ],
}

function Harness({ onPick = () => {}, canAdopt = true }: { onPick?: (id: string, on: boolean) => void; canAdopt?: boolean }) {
  const [selection, setSelection] = useState<SdlcSelection | null>(null)
  return (
    <>
      <SdlcMatrix audit={audit} selection={selection} onSelect={setSelection} picked={new Set()} onPick={onPick} canAdopt={canAdopt} />
      <SdlcEvidence audit={audit} selection={selection} />
    </>
  )
}

it('groups plays under their stage, in catalog order', () => {
  expect(stageGroups(plays).map((g) => [g.stage, g.plays.map((p) => p.id)])).toEqual([
    ['plan', ['intent']],
    ['build', ['claude-md', 'skills']],
  ])
})

it('counts present plays only over projects that could be scanned', () => {
  expect(fleetCount(audit, 'skills')).toEqual({ present: 1, scanned: 1 })
  expect(fleetCount(audit, 'intent')).toEqual({ present: 0, scanned: 1 })
})

it('names every score in words, so colour is never the only signal', () => {
  render(<Harness />)
  expect(screen.getByRole('button', { name: 'Alpha, Capture as intent.md: Absent' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Alpha, CLAUDE.md: Partial' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Alpha, Skills: Present' })).toBeTruthy()
})

it('shows the note and the files behind a selected cell, and clears on a second click', () => {
  render(<Harness />)
  const cell = screen.getByRole('button', { name: 'Alpha, CLAUDE.md: Partial' })
  fireEvent.click(cell)
  const evidence = screen.getByRole('region', { name: 'Evidence' })
  expect(within(evidence).getByText(/212 lines/)).toBeTruthy()
  expect(within(evidence).getByText('CLAUDE.md')).toBeTruthy()
  expect(cell.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(cell)
  expect(within(screen.getByRole('region', { name: 'Evidence' })).getByText(/Select a cell/)).toBeTruthy()
})

it('says plainly when nothing was found', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Alpha, Capture as intent.md: Absent' }))
  expect(screen.getByText('Nothing found for this play.')).toBeTruthy()
})

it('greys out a project whose folder is gone, with no cells and no way to select it', () => {
  render(<Harness />)
  expect(screen.getByText('Project folder unavailable')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Gone,/ })).toBeNull()
  expect((screen.getByLabelText('Select Gone for baseline adoption') as HTMLInputElement).disabled).toBe(true)
})

it('reports the baseline state and the next move per project', () => {
  render(<Harness />)
  expect(screen.getByText(/Baseline outdated · next: Capture as intent\.md/)).toBeTruthy()
})

it('lets a scanned project be picked, and hides selection when adoption is unavailable (hosted)', () => {
  const onPick = vi.fn()
  const { unmount } = render(<Harness onPick={onPick} />)
  fireEvent.click(screen.getByLabelText('Select Alpha for baseline adoption'))
  expect(onPick).toHaveBeenCalledWith('alpha', true)
  unmount()
  render(<Harness canAdopt={false} />)
  expect(screen.queryByLabelText(/for baseline adoption/)).toBeNull()
})
