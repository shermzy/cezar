import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * Delivery tracking in a real browser.
 *
 * Failure cases pinned here before the UI exists:
 * - an old run without delivery state still opens normally and offers tracking only when an
 *   authoritative PR association exists, including a legacy marker-only association;
 * - a persisted ci-passed record renders the merge commit, checked time, PR and Actions links,
 *   plus the explicit "no release/deployment" boundary;
 * - Refresh delivery is a single explicit POST, with no browser polling loop;
 * - the panel remains usable at a narrow viewport and its action is keyboard reachable.
 *
 * The fixture uses a repo with no forge remote. Its refresh therefore degrades to the product's
 * honest unknown state without GitHub credentials or network access; the persisted record covers
 * the evidence rendering path deterministically.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/delivery')
const sessionId = `e2e-delivery-${process.pid}`
const SHA = 'a'.repeat(40)
const CHECKED_AT = '2026-10-06T10:00:00.000Z'

const FIXTURE = [
  {
    id: 'delivery-passed',
    title: 'Delivery evidence fixture',
    workflow: 'quick-task',
    task: 'delivery evidence fixture',
    status: 'done',
    createdAt: CHECKED_AT,
    finishedAt: CHECKED_AT,
    startedAt: CHECKED_AT,
    tokensUsed: 0,
    archived: false,
    steps: [],
    prRefs: [{
      number: 21,
      url: 'https://github.com/acme/repo/pull/21',
      origin: 'created',
      at: CHECKED_AT,
    }],
    delivery: {
      status: 'ci-passed',
      startedAt: CHECKED_AT,
      checkedAt: CHECKED_AT,
      repository: {
        host: 'github.com',
        owner: 'acme',
        name: 'repo',
        url: 'https://github.com/acme/repo',
      },
      prs: [{
        number: 21,
        url: 'https://github.com/acme/repo/pull/21',
        state: 'merged',
        mergeable: 'mergeable',
        baseRef: 'main',
        mergeCommitSha: SHA,
      }],
      checks: [{
        workflow: 'CI',
        runId: 21,
        runAttempt: 1,
        sha: SHA,
        branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/repo/actions/runs/21',
      }],
      reason: 'Integration CI passed for the merged commit.',
    },
  },
  {
    id: 'delivery-refresh',
    title: 'Refresh delivery fixture',
    workflow: 'quick-task',
    task: 'refresh delivery fixture',
    status: 'done',
    createdAt: CHECKED_AT,
    finishedAt: CHECKED_AT,
    tokensUsed: 0,
    archived: false,
    steps: [],
    prRefs: [{
      number: 23,
      url: 'https://github.com/acme/repo/pull/23',
      origin: 'created',
      at: CHECKED_AT,
    }],
    delivery: {
      status: 'ci-passed',
      startedAt: CHECKED_AT,
      checkedAt: CHECKED_AT,
      repository: {
        host: 'github.com',
        owner: 'acme',
        name: 'repo',
        url: 'https://github.com/acme/repo',
      },
      prs: [{
        number: 23,
        url: 'https://github.com/acme/repo/pull/23',
        state: 'merged',
        mergeable: 'mergeable',
        baseRef: 'main',
        mergeCommitSha: SHA,
      }],
      checks: [{
        workflow: 'CI',
        runId: 23,
        runAttempt: 1,
        sha: SHA,
        branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/repo/actions/runs/23',
      }],
      reason: 'Integration CI passed for the merged commit.',
    },
  },
  {
    id: 'delivery-start',
    title: 'Start delivery fixture',
    workflow: 'quick-task',
    task: 'start delivery fixture',
    status: 'done',
    createdAt: CHECKED_AT,
    finishedAt: CHECKED_AT,
    tokensUsed: 0,
    archived: false,
    steps: [],
    prRefs: [{
      number: 22,
      url: 'https://github.com/acme/repo/pull/22',
      origin: 'marker',
      at: CHECKED_AT,
    }],
  },
  {
    id: 'delivery-marker-legacy',
    title: 'Legacy marker delivery fixture',
    workflow: 'quick-task',
    task: 'legacy marker delivery fixture',
    status: 'done',
    createdAt: CHECKED_AT,
    finishedAt: CHECKED_AT,
    tokensUsed: 0,
    archived: false,
    steps: [],
    markerRefs: { pr: 24 },
  },
  {
    id: 'delivery-display-only',
    title: 'Display-only PR fixture',
    workflow: 'quick-task',
    task: 'display-only PR fixture',
    status: 'done',
    createdAt: CHECKED_AT,
    finishedAt: CHECKED_AT,
    tokensUsed: 0,
    archived: false,
    steps: [],
    referencedPullRequestUrl: 'https://github.com/acme/repo/pull/77',
    prNumber: 77,
    prRefs: [{ number: 77, origin: 'derived', at: CHECKED_AT }],
  },
]

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`cezar e2e: the delivery fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
let processRecord: {
  pid: number
  creation: string
  parentPid?: number
  command: string
  cwd: string
  owner: string
  state: 'running' | 'stopped'
}

function processInfo(pid: number): { pid: number; creation: string; parent?: number; command?: string } | null {
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p | Select-Object ProcessId,CreationDate,ParentProcessId,CommandLine | ConvertTo-Json -Compress}`],
        { encoding: 'utf8' },
      ).trim()
      if (!raw) return null
      const value = JSON.parse(raw) as { ProcessId: number; CreationDate: string; ParentProcessId?: number; CommandLine?: string }
      return { pid: value.ProcessId, creation: value.CreationDate, parent: value.ParentProcessId, command: value.CommandLine }
    }
    const raw = execFileSync('ps', ['-o', 'pid=,lstart=,ppid=,args=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (!raw) return null
    const match = raw.match(/^\s*(\d+)\s+(.{24})\s+(\d+)\s+(.*)$/)
    if (!match) return null
    const pidText = match[1]
    const creation = match[2]
    const parentText = match[3]
    const command = match[4]
    if (!pidText || !creation || !parentText || command === undefined) return null
    return { pid: Number(pidText), creation, parent: Number(parentText), command }
  } catch {
    return null
  }
}

async function waitForProcessInfo(pid: number): Promise<NonNullable<ReturnType<typeof processInfo>>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const info = processInfo(pid)
    if (info) return info
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`cezar e2e: could not verify the delivery fixture process ${pid}`)
}

function ownsDeliveryProcess(info: ReturnType<typeof processInfo>): boolean {
  return Boolean(
    info &&
      processRecord &&
      info.creation === processRecord.creation &&
      info.command?.includes(cezarCli) &&
      info.command?.includes(dataRoot),
  )
}

async function stopOwnedServer(): Promise<void> {
  if (!processRecord) return
  const before = processInfo(processRecord.pid)
  if (!ownsDeliveryProcess(before)) {
    throw new Error(`cezar e2e: refusing to stop an unverified delivery fixture process ${processRecord.pid}`)
  }
  if (server.exitCode === null) {
    server.kill('SIGINT')
    await Promise.race([
      once(server, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
  let after = processInfo(processRecord.pid)
  if (ownsDeliveryProcess(after)) {
    server.kill('SIGTERM')
    await Promise.race([
      once(server, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    after = processInfo(processRecord.pid)
  }
  processRecord.state = 'stopped'
  writeFileSync(resolve(artifactsDir, 'delivery-process.json'), JSON.stringify({ ...processRecord, stoppedAt: new Date().toISOString() }, null, 2))
  if (ownsDeliveryProcess(after)) {
    throw new Error(`cezar e2e: delivery fixture process ${processRecord.pid} remained after verified shutdown`)
  }
}

const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-delivery-'))
  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { cwd: dataRoot, env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  if (server.pid === undefined) throw new Error('cezar e2e: delivery fixture did not start')
  const started = await waitForProcessInfo(server.pid)
  mkdirSync(artifactsDir, { recursive: true })
  processRecord = {
    pid: started.pid,
    creation: started.creation,
    parentPid: started.parent,
    command: started.command ?? `${process.execPath} ${cezarCli} serve`,
    cwd: dataRoot,
    owner: sessionId,
    state: 'running',
  }
  writeFileSync(resolve(artifactsDir, 'delivery-process.json'), JSON.stringify(processRecord, null, 2))
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(async () => {
  browser?.close()
  await stopOwnedServer()
  if (dataRoot && processRecord?.state === 'stopped') rmSync(dataRoot, { recursive: true, force: true })
})

describe('delivery tracking', () => {
  it('does not offer tracking for a display-only PR reference', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-display-only')}`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"]') !== null`)
    expect(browser.count('[data-slot="delivery-panel"]')).toBe(0)
  })

  it('offers tracking for a legacy marker-only PR association', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-marker-legacy')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-track"]') !== null`)
    expect(browser.count('[data-slot="delivery-panel"]')).toBe(1)
  })

  it('renders persisted CI evidence and its explicit integration boundary', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-passed')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-status"]') !== null`)

    expect(browser.text('[data-slot="delivery-status"]')).toContain('Integration CI passed')
    expect(browser.text('[data-slot="delivery-panel"]')).toContain(SHA)
    expect(browser.text('[data-slot="delivery-panel"]')).toContain('Checked')
    expect(browser.text('[data-slot="delivery-panel"]')).toContain('No release, deployment, or acceptance is claimed')
    expect(browser.evaluate(`document.querySelector('[data-slot="delivery-pr"]').getAttribute('href')`)).toBe(
      'https://github.com/acme/repo/pull/21',
    )
    expect(browser.evaluate(`document.querySelector('[data-slot="delivery-check"]').getAttribute('href')`)).toBe(
      'https://github.com/acme/repo/actions/runs/21',
    )
    browser.screenshot(`${artifactsDir}/delivery-passed.png`)
  })

  it('starts tracking only after the explicit button and does not poll', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-start')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-track"]') !== null`)
    expect(browser.count('[data-slot="delivery-status"]')).toBe(0)

    browser.click('[data-slot="delivery-track"]')
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-panel"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-refresh"]') !== null`)
    expect(browser.text('[data-slot="delivery-status"]')).toContain('Unknown')

    // The route has no timer or response loop: over a settled window this remains one explicit
    // refresh request. Resource timing records fetches in the real browser session.
    const refreshes = browser.evaluate(
      `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/delivery/refresh')).length`,
    ) as number
    expect(refreshes).toBe(1)
  })

  it('preserves prior evidence as stale and unknown when refresh cannot reach a forge', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-refresh')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-refresh"]') !== null`)
    browser.click('[data-slot="delivery-refresh"]')
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-status"]')?.textContent.includes('Unknown')`)

    expect(browser.text('[data-slot="delivery-panel"]')).toContain('Stale evidence')
    expect(browser.text('[data-slot="delivery-panel"]')).toContain(SHA)
    expect(browser.evaluate(`document.querySelector('[data-slot="delivery-pr"]').getAttribute('href')`)).toBe(
      'https://github.com/acme/repo/pull/23',
    )
  })

  it('keeps tracking actions keyboard reachable on a narrow viewport', () => {
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-passed')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-refresh"]') !== null`)
    browser.setViewport(390, 844)
    // Use the existing no-flash theme path: storage is read on navigation, then ThemeProvider
    // applies the resolved class and color scheme before the screenshot.
    browser.evaluate(`localStorage.setItem('cez-theme', 'dark')`)
    browser.goto(`${baseUrl}${scoped('/tasks/delivery-passed')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-refresh"]') !== null`)

    const accessible = browser.evaluate(`(() => {
      const panel = document.querySelector('[data-slot="delivery-panel"]')
      const refresh = document.querySelector('[data-slot="delivery-refresh"]')
      return {
        label: panel?.getAttribute('aria-label'),
        refreshName: refresh?.getAttribute('aria-label') || refresh?.textContent,
        overflow: panel ? panel.scrollWidth > panel.clientWidth : true,
      }
    })()`) as { label: string | null; refreshName: string | null; overflow: boolean }
    expect(accessible.label).toBe('Delivery tracking')
    expect(accessible.refreshName).toContain('Refresh delivery')
    expect(accessible.overflow).toBe(false)
    expect(browser.evaluate(`document.documentElement.classList.contains('light')`)).toBe(false)
    expect(browser.evaluate(`document.documentElement.style.colorScheme`)).toBe('dark')
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="app-shell"]')).backgroundColor`)).not.toBe('rgba(0, 0, 0, 0)')

    browser.evaluate(`document.querySelector('[data-slot="delivery-refresh"]').focus()`)
    expect(browser.evaluate(`document.activeElement?.getAttribute('data-slot')`)).toBe('delivery-refresh')
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('[data-slot="delivery-status"]')?.textContent.includes('Unknown')`)
    browser.screenshot(`${artifactsDir}/delivery-narrow.png`)
    browser.setViewport(1440, 900)
  })
})
