import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * The all-projects board at `/board` (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1b)
 * against its own dry-run server.
 *
 * Part A runs everywhere, Windows included: one project (the boot folder — unregistered on
 * Windows, where the registry only stores POSIX roots), the phase-1 setup of `maxParallel: 1`, a
 * `mock:slow` run A that holds the slot and then parks at `waiting`, and a `mock:slow mock:done`
 * run B that waits in Queued, works in Running and ends in Review or Done. The board is opened
 * BEFORE either run starts, so the boot lane and every card arrive over the live stream.
 *
 * Part B needs a multi-project registry, which only POSIX roots can enter
 * (`packages/cezar/src/workspace/config.ts:48`): it skips LOUDLY on win32 and under
 * `CEZ_SINGLE_PROJECT=1`, and runs on Linux — on a Windows machine, in WSL (CI runs no e2e). It
 * registers three fixture projects in this suite's own `CEZ_HOME` and seeds their `runs.json` on
 * disk. It assumes nothing about what part A left behind, so it also runs on its own (`-t 'part B'`).
 *
 * On Linux the boot folder auto-registers (`packages/cezar/src/workspace/projects.ts:151-160`), so
 * part A there exercises the index-fed boot lane, where Windows exercises the unregistered one.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-board-all-${process.pid}`

/** Why part B cannot run on this machine, or `null` when it can. Decided at collection time: the
 *  suite's server inherits this process's env (`fixtureServeEnv`), so the env IS the server's
 *  `capabilities.singleProject` (`packages/cezar/src/server/capabilities.ts:168`). */
const PART_B_SKIP =
  process.platform === 'win32'
    ? 'win32 — the workspace registry only stores POSIX roots (packages/cezar/src/workspace/config.ts:48), so no fixture project can be registered'
    : process.env.CEZ_SINGLE_PROJECT === '1'
      ? 'CEZ_SINGLE_PROJECT=1 — the server lists only the boot project'
      : null

if (PART_B_SKIP !== null) {
  const bar = '!'.repeat(78)
  // Straight to stderr: vitest does not print a `console.*` call made while it collects a file.
  process.stderr.write(
    `\n${bar}\n  board-all.e2e.ts PART B (multi-project lanes) IS SKIPPED: ${PART_B_SKIP}.\n  Run it on Linux: in WSL (Ubuntu), as the plan's WSL step does. A skip is not a pass.\n${bar}\n\n`,
  )
}

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
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the all-boards server never answered at ${url}`)
}

async function startRun(url: string, task: string): Promise<string> {
  // Yield to the event loop first. This suite drives the browser through SYNCHRONOUS calls
  // (`execFileSync`) that block it for seconds, during which the server closes the idle keep-alive
  // socket Node's fetch pooled; a request sent at once goes out on that dead socket and answers
  // `ECONNRESET`. The POST is never retried — it would start a second run. (The same yield, and its
  // measurements, are in `hosted-accounts-manage.e2e.ts`.)
  await new Promise<void>((r) => setTimeout(r, 50))
  const response = await fetch(`${url}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workflow: 'quick-task' }),
  })
  if (!response.ok) throw new Error(`cezar e2e: POST /runs answered ${response.status}`)
  return ((await response.json()) as { id: string }).id
}

async function waitForStatus(url: string, id: string, wanted: string[], tries = 240): Promise<string> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const { status } = await getJson<{ status: string }>(`${url}/api/v1/runs/${id}`)
    if (wanted.includes(status)) return status
    // Anything but queued/running is a resting state (done, failed, cancelled, review, waiting):
    // the run is not going to become one of `wanted` — say so now instead of polling into a timeout.
    if (status !== 'queued' && status !== 'running') {
      throw new Error(`cezar e2e: run ${id} ended as ${status}, wanted ${wanted.join('/')}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached ${wanted.join('/')}`)
}

/** The board has loaded (`useProjects`, the index and — when needed — the boot run list). */
const ALL_BOARDS_READY = `document.querySelector('[data-slot="all-boards"]') !== null`

const laneSelector = (projectId: string) => `[data-slot="board-lane"][data-project-id="${projectId}"]`

/** `true`/`false` from the lane's disclosure button, or `null` when the lane is not rendered. */
const laneExpanded = (projectId: string): string =>
  `(document.querySelector('${laneSelector(projectId)} [data-slot="board-lane-toggle"]')?.getAttribute('aria-expanded') ?? null)`

/** The column a run's card currently sits in, read from the DOM — `null` when no card. */
const cellOf = (runId: string): string =>
  `(document.querySelector('[data-slot="board-card"][data-run-id="${runId}"]')?.closest('[data-slot="board-cell"]')?.dataset.column ?? null)`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let cezHome: string
let baseUrl: string
let bootProject: string
/** Part B's fixture projects. Removed in the top-level `afterAll`, AFTER the server that may hold
 *  them open has stopped. */
let seedDir: string | undefined

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-board-all-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# all-boards e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const env = fixtureServeEnv(dataRoot)
  cezHome = env.CEZ_HOME as string
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ resources: { maxParallel: 1 } }), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env,
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  // Only while the child is still ours and alive: once Node has reaped it, Windows may hand its PID
  // to an unrelated process, and `taskkill /T /F` on that would end somebody else's tree.
  if (server?.pid !== undefined && server.exitCode === null && server.signalCode === null) {
    // Listen before killing, so the exit cannot be missed.
    const exited = new Promise<void>((done) => server.once('exit', () => done()))
    if (process.platform === 'win32') {
      // `server.kill()` ends only the cezar process and orphans its dry-run mock agents on Windows.
      // This is the tree this suite spawned itself, so ending all of it is safe.
      try {
        execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    } else {
      server.kill()
    }
    // Bounded: a server that never reports its exit must not hang the suite's teardown.
    let timer: NodeJS.Timeout | undefined
    const gaveUp = new Promise<void>((done) => {
      timer = setTimeout(done, 10_000)
    })
    await Promise.race([exited, gaveUp])
    clearTimeout(timer)
  }
  // Windows keeps the killed server's handles for a beat — retry instead of failing on EBUSY.
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  if (seedDir) rmSync(seedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  // 90 s: `browser.close()` can itself block up to the 60 s `execFileSync` timeout, and the server
  // teardown (up to 10 s) and the rmSync retries come after it.
}, 90_000)

describe('part A — the boot lane, live (every platform)', () => {
  let runA: string
  let runB: string
  let finalB: string

  beforeAll(() => {
    // Opened before any run exists: the lane and its cards must arrive live.
    browser.goto(`${baseUrl}/board`)
    browser.waitForFunction(ALL_BOARDS_READY)
  }, 120_000)

  it('titles the page "All boards"', () => {
    expect(String(browser.evaluate('document.title'))).toMatch(/^All boards/)
  })

  it('before any run: no lane, the column header, the hint and the quiet toggle — and one project has no door', () => {
    expect(browser.count('[data-slot="board-lane"]')).toBe(0)
    expect(browser.isVisible('[data-slot="board-column-headers"]')).toBe(true)
    expect(browser.text('[data-slot="board-empty-hint"]')).toBe('No tasks yet in any project')
    expect(browser.text('[data-slot="board-quiet-toggle"]')).toBe('Show 1 quiet project')
    expect(browser.count('[data-slot="all-boards-link"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/board-all-empty.png`)
  })

  it('a started run brings the boot lane in, expanded, with the run in Running', async () => {
    runA = await startRun(baseUrl, 'mock:slow A holds the only slot, then parks for you')
    await waitForStatus(baseUrl, runA, ['running'])
    browser.waitForFunction(`${laneExpanded(bootProject)} === 'true' && ${cellOf(runA)} === 'running'`)
    expect(browser.count('[data-slot="board-empty-hint"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/board-all-running.png`)
  }, 120_000)

  it('a second run waits in Queued, works in Running, then lands in Review or Done — live', async () => {
    runB = await startRun(baseUrl, 'mock:slow mock:done B waits its turn')
    browser.waitForFunction(`${cellOf(runB)} === 'queued'`)
    browser.screenshot(`${artifactsDir}/board-all-queued.png`)

    // The user's toggle wins over the live default. A is still running (it holds its turn ~25 s),
    // so the lane is `active` and open by default; collapse it, let B move Queued → Running while
    // it is shut, and it must still be shut — then open it again for the assertions below.
    const toggle = `${laneSelector(bootProject)} [data-slot="board-lane-toggle"]`
    browser.click(toggle)
    browser.waitForFunction(`${laneExpanded(bootProject)} === 'false'`)

    await waitForStatus(baseUrl, runA, ['waiting'])
    await waitForStatus(baseUrl, runB, ['running'])
    // A collapsed lane draws no cards; its header counts are what shows the live update arrived.
    const counts = `(document.querySelector('${laneSelector(bootProject)} [data-slot="board-lane-counts"]')?.textContent ?? '')`
    browser.waitForFunction(`/1 running/.test(${counts}) && /1 needs you/.test(${counts})`)
    expect(browser.evaluate(laneExpanded(bootProject))).toBe('false')

    browser.click(toggle)
    browser.waitForFunction(`${laneExpanded(bootProject)} === 'true'`)
    // Park the pointer off the chevron, so the screenshot below does not catch its hover state.
    browser.hover('[data-slot="board-column-headers"]')
    browser.waitForFunction(`${cellOf(runA)} === 'needs-you' && ${cellOf(runB)} === 'running'`)

    // Strict: a failed run must fail this test, not be waved through as "Done". Each of the two
    // statuses has the column of the same name.
    finalB = await waitForStatus(baseUrl, runB, ['review', 'done'])
    browser.waitForFunction(`${cellOf(runB)} === '${finalB}'`)
    browser.screenshot(`${artifactsDir}/board-all-finished.png`)
  }, 180_000)

  it("a card opens its task page in its own project's scope", () => {
    const target = `/p/${encodeURIComponent(bootProject)}/tasks/${encodeURIComponent(runB)}`
    const card = `[data-slot="board-card"][data-run-id="${runB}"]`
    expect(browser.evaluate(`document.querySelector('${card}')?.getAttribute('href') ?? null`)).toBe(target)
    browser.click(card)
    browser.waitForFunction(`location.pathname === ${JSON.stringify(target)}`)
    browser.evaluate('history.back()')
    browser.waitForFunction(`${ALL_BOARDS_READY} && ${cellOf(runB)} === '${finalB}'`)
  })

  it('at the narrowest desktop width, every column still sits inside its lane', () => {
    // 1024 px is narrower than the five 180 px columns plus the lane's own padding and border, so
    // the board scrolls sideways. A column must not hang out of its lane's frame while it does.
    browser.setViewport(1024, 768)
    browser.waitForFunction(
      `getComputedStyle(document.querySelector('[data-slot="board-column-headers"]')).display !== 'none'`,
    )
    const lane = laneSelector(bootProject)
    const overhang = browser.evaluate(
      `(() => {
        const frame = document.querySelector('${lane}').getBoundingClientRect()
        return Math.max(...[...document.querySelectorAll('${lane} [data-slot="board-cell"]')]
          .map((cell) => cell.getBoundingClientRect().right - frame.right))
      })()`,
    ) as number
    expect(overhang).toBeLessThanOrEqual(0)
    browser.setViewport(1440, 900)
  })

  it('on a phone, the expanded lane stacks only the columns that hold work', () => {
    browser.setViewport(390, 844)
    browser.waitForFunction(
      `getComputedStyle(document.querySelector('[data-slot="board-column-headers"]')).display === 'none'`,
    )
    const shown = browser.evaluate(
      `[...document.querySelectorAll('${laneSelector(bootProject)} [data-slot="board-cell"]')]
        .filter((cell) => getComputedStyle(cell).display !== 'none')
        .map((cell) => cell.dataset.column + ':' + cell.querySelectorAll('[data-slot="board-card"]').length)`,
    ) as string[]
    expect(shown).toEqual(['needs-you:1', `${finalB}:1`])
    browser.screenshot(`${artifactsDir}/board-all-mobile.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })
})

describe.skipIf(PART_B_SKIP !== null)('part B — every registered project, in sidebar order (Linux)', () => {
  /** X has a run waiting for review (active, expanded); Y one run done an hour ago (done-only,
   *  collapsed); Z nothing (quiet). Ids obey the registry's slug rule. */
  const X = { id: 'e2e-lane-x', name: 'lane x' }
  const Y = { id: 'e2e-lane-y', name: 'lane y' }
  const Z = { id: 'e2e-lane-z', name: 'lane z' }
  const SEEDED = [X.id, Y.id, Z.id]
  /** The palette's All boards row — `data-nav-to="/board"` alone is shared with the per-project
   *  Board row, so the global marker is what makes this selector name one row. */
  const PALETTE_ALL_BOARDS = '[data-slot="palette-view"][data-nav-scope="global"][data-nav-to="/board"]'
  /** Every project the server lists after the seeding — the lanes the board can draw. */
  let registeredIds: string[] = []

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cezar-e2e-board-all-lanes-'))
    seedDir = dir
    const now = Date.now()
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString()

    /**
     * A record `runRecordSchema` accepts (`packages/cezar/src/runs/store.ts`). Only resting
     * states: the index reads a cold project straight off disk, and a `running`/`queued`/`waiting`
     * row there reads back as `failed` (`reconcileLoadedRun`, `store.ts:757-763`).
     */
    const record = (id: string, title: string, status: 'review' | 'done') => ({
      id,
      title,
      workflow: 'quick-task',
      task: title,
      status,
      createdAt: hoursAgo(2),
      startedAt: hoursAgo(2),
      finishedAt: hoursAgo(1),
      tokensUsed: 0,
      archived: false,
      steps: [],
    })

    /** A real (empty) git repo, so the registry probe answers `ok`, holding the given runs. */
    const seedRepo = (id: string, runs: ReturnType<typeof record>[]): string => {
      const root = join(dir, id)
      execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
      if (runs.length > 0) {
        mkdirSync(join(root, '.ai', 'cezar'), { recursive: true })
        writeFileSync(join(root, '.ai', 'cezar', 'runs.json'), JSON.stringify(runs), 'utf8')
      }
      return realpathSync(root)
    }

    const entry = (project: { id: string; name: string }, root: string, lastOpenedAt: string) => ({
      ...project,
      root,
      addedAt: '2026-07-01T00:00:00.000Z',
      lastOpenedAt,
      source: 'local' as const,
    })
    const x = entry(X, seedRepo(X.id, [record('seed-x-review', 'x waits for review', 'review')]), '2026-07-20T12:00:00.000Z')
    const y = entry(Y, seedRepo(Y.id, [record('seed-y-done', 'y finished an hour ago', 'done')]), '2026-07-19T12:00:00.000Z')
    const z = entry(Z, seedRepo(Z.id, []), '2026-07-18T12:00:00.000Z')

    // Append to whatever the server already wrote (on Linux it registered the boot folder), keep
    // every other key, and store them Z, Y, X: the expected X, Y, Z order then comes from
    // `lastOpenedAt` (the sidebar's rule), never from file order. `GET /projects` and the runs
    // index read this file per request, so the next page load sees it — no restart.
    const configPath = join(cezHome, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { projects?: unknown[] } & Record<string, unknown>
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, projects: [...(config.projects ?? []), z, y, x] }, null, 2)}\n`,
      { mode: 0o600 },
    )

    registeredIds = (await getJson<{ projects: Array<{ id: string }> }>(`${baseUrl}/api/v1/projects`)).projects.map(
      (project) => project.id,
    )
    expect(registeredIds).toEqual(expect.arrayContaining(SEEDED))

    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}/board`)
    browser.waitForFunction(
      `${ALL_BOARDS_READY} && document.querySelector('${laneSelector(X.id)}') !== null && document.querySelector('${laneSelector(Y.id)}') !== null`,
    )
  }, 120_000)

  it('lays the lanes out in the sidebar order', () => {
    const sidebar = (
      browser.evaluate(`[...document.querySelectorAll('[data-slot="project-group"]')].map((n) => n.dataset.project)`) as string[]
    ).filter((id) => SEEDED.includes(id))
    expect(sidebar).toEqual([X.id, Y.id, Z.id])
    // Z is quiet, so it is not on the board yet; the lanes that are keep the sidebar's order.
    const lanes = (
      browser.evaluate(`[...document.querySelectorAll('[data-slot="board-lane"]')].map((n) => n.dataset.projectId)`) as string[]
    ).filter((id) => SEEDED.includes(id))
    expect(lanes).toEqual([X.id, Y.id])
    browser.screenshot(`${artifactsDir}/board-all-lanes.png`)
  })

  it('expands the lane with work waiting for review', () => {
    expect(browser.evaluate(laneExpanded(X.id))).toBe('true')
    expect(browser.evaluate(cellOf('seed-x-review'))).toBe('review')
  })

  it('collapses the lane whose only card is done, and says so', () => {
    expect(browser.evaluate(laneExpanded(Y.id))).toBe('false')
    expect(browser.text(`${laneSelector(Y.id)} [data-slot="board-lane-counts"]`)).toBe('(1 done)')
    expect(browser.count(`${laneSelector(Y.id)} [data-slot="board-card"]`)).toBe(0)
  })

  it('keeps the project with no runs behind the quiet toggle, and reveals it as a quiet lane', () => {
    // Not before the toggle: Z is absent from the lanes on the board.
    expect(browser.count(laneSelector(Z.id))).toBe(0)
    // The hidden group is every listed project without a lane on the board. That holds whatever
    // part A did or did not leave in the boot lane (it is quiet when part B runs on its own).
    const drawn = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="board-lane"]')].map((n) => n.dataset.projectId)`,
    ) as string[]
    const hidden = registeredIds.filter((id) => !drawn.includes(id))
    expect(hidden).toContain(Z.id)
    expect(browser.text('[data-slot="board-quiet-toggle"]')).toBe(
      `Show ${hidden.length} quiet ${hidden.length === 1 ? 'project' : 'projects'}`,
    )

    browser.click('[data-slot="board-quiet-toggle"]')
    browser.waitForFunction(`document.querySelector('${laneSelector(Z.id)}') !== null`)
    expect(browser.evaluate(`document.querySelector('${laneSelector(Z.id)}')?.dataset.kind ?? null`)).toBe('quiet')
    browser.click('[data-slot="board-quiet-toggle"]')
    browser.waitForFunction(`document.querySelector('${laneSelector(Z.id)}') === null`)
  })

  it('lights the "All boards" door, and the palette takes you there from inside a project', () => {
    const doorCurrent = `document.querySelector('[data-slot="all-boards-link"]')?.getAttribute('aria-current') ?? null`
    expect(browser.evaluate(doorCurrent)).toBe('page')

    // From a project's own page, the palette must leave the scope — not open `/p/<x>/board`.
    const projectHome = `/p/${X.id}/`
    browser.goto(`${baseUrl}${projectHome}`)
    browser.waitForFunction(
      `location.pathname === '${projectHome}' && document.querySelector('[data-slot="sidebar"]') !== null`,
    )
    expect(browser.evaluate(doorCurrent)).toBe(null)
    browser.press('Control+k')
    browser.waitForFunction(`document.querySelector('${PALETTE_ALL_BOARDS}') !== null`)
    expect(browser.text(PALETTE_ALL_BOARDS)).toBe('All boards')
    browser.click(PALETTE_ALL_BOARDS)
    browser.waitForFunction(`location.pathname === '/board' && document.querySelector('[cmdk-root]') === null`)
    browser.waitForFunction(ALL_BOARDS_READY)
    expect(browser.evaluate(doorCurrent)).toBe('page')
  })
})
