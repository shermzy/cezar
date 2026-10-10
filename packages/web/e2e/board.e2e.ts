import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * The Board (spec `.ai/specs/2026-10-04-kanban-board.md`, phase 1) against its own dry-run
 * server: cards sit in the column their run's status says, arrive and move LIVE (no reload) as
 * the mock agent works, open their task page, and the mobile layout switches columns.
 *
 * The board is opened BEFORE either run starts, so the cards also arrive over the live stream
 * rather than from the first fetch, and the page load does not eat into the ~25 s windows below.
 * Two `mock:slow` runs on a one-slot server make every column observable: A holds the slot,
 * then parks at `waiting` (no done marker — Needs you); B waits in Queued, works in Running for
 * ~25 s, and ends in Review/Done (`mock:done`).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-board-${process.pid}`

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
  throw new Error(`cezar e2e: the board server never answered at ${url}`)
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

/** The column a run's card currently sits in, read from the DOM — `null` when no card. */
const columnOf = (id: string): string =>
  `(document.querySelector('[data-slot="board-card"][data-run-id="${id}"]')?.closest('[data-slot="board-column"]')?.dataset.column ?? null)`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let runA: string
let runB: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-board-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# board e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const env = fixtureServeEnv(dataRoot)
  const cezHome = env.CEZ_HOME as string
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ resources: { maxParallel: 1 } }), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env,
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${encodeURIComponent(await bootProjectId(baseUrl))}/board`)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="board-column"]').length === 5`)

  runA = await startRun(baseUrl, 'mock:slow A holds the only slot, then parks for you')
  await waitForStatus(baseUrl, runA, ['running'])
  runB = await startRun(baseUrl, 'mock:slow mock:done B waits its turn')
}, 180_000)

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
  // 90 s: `browser.close()` can itself block up to the 60 s `execFileSync` timeout, and the server
  // teardown (up to 10 s) and the rmSync retries come after it.
}, 90_000)

describe('the Board against a live dry-run server', () => {
  it('renders the six columns in order, and the sidebar lights Board', () => {
    const columns = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="board-column"]')].map((c) => c.dataset.column)`,
    ) as string[]
    expect(columns).toEqual(['queued', 'running', 'needs-you', 'review', 'not-doing', 'done'])
    expect(browser.isVisible('nav a[aria-current="page"][href$="/board"]')).toBe(true)
  })

  it('shows the slot-holding run in Running and the second run in Queued', () => {
    browser.waitForFunction(`${columnOf(runA)} === 'running' && ${columnOf(runB)} === 'queued'`)
    expect(browser.text('[data-column="queued"] [data-slot="board-column-count"]')).toBe('1')
    browser.screenshot(`${artifactsDir}/board-queued-running.png`)
  })

  it(
    'moves cards live, without a reload: A parks in Needs you, B works in Running, then lands in Review/Done',
    async () => {
      await waitForStatus(baseUrl, runA, ['waiting'])
      await waitForStatus(baseUrl, runB, ['running'])
      browser.waitForFunction(`${columnOf(runA)} === 'needs-you' && ${columnOf(runB)} === 'running'`)
      browser.screenshot(`${artifactsDir}/board-needs-you-running.png`)

      // Strict: a failed run must fail this test, not be waved through as "Done". Each of the two
      // statuses has the column of the same name.
      const finalB = await waitForStatus(baseUrl, runB, ['review', 'done'])
      browser.waitForFunction(`${columnOf(runB)} === '${finalB}'`)
      browser.screenshot(`${artifactsDir}/board-finished.png`)
    },
    180_000,
  )

  it('a card opens its task page', () => {
    browser.click(`[data-slot="board-card"][data-run-id="${runB}"]`)
    browser.waitForFunction(`location.pathname.endsWith('/tasks/${runB}')`)
    expect(browser.url()).toContain(`/tasks/${runB}`)
    browser.evaluate('history.back()')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="board-column"]').length === 5`)
  })

  it('on a phone, the column switcher brings the chosen column into view', () => {
    browser.setViewport(390, 844)
    // The switcher is always in the DOM — `md:hidden` is CSS — so presence proves nothing. Wait
    // for it to lay out (the control itself stays `display: flex`; its `md:hidden` wrapper is what
    // collapses it, so the box is what says it is on screen).
    const switcher = '[data-slot="board-switcher"]'
    browser.waitForFunction(`(() => {
      const el = document.querySelector('${switcher}')
      if (!el) return false
      const box = el.getBoundingClientRect()
      return getComputedStyle(el).display !== 'none' && box.width > 0 && box.height > 0
    })()`)
    expect(browser.isVisible(switcher)).toBe(true)
    // A real click: the CLI scrolls the button into view, refuses a covered or hidden one, and
    // sends a trusted pointer event — a scripted `.click()` would pass with the switcher hidden.
    browser.click(`${switcher} button[data-value="done"]`)
    browser.waitForFunction(`(() => {
      const done = document.querySelector('[data-column="done"]')?.getBoundingClientRect()
      return done !== undefined && done.left >= -1 && done.left < window.innerWidth / 2
    })()`)
    browser.screenshot(`${artifactsDir}/board-mobile-done.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })
})
