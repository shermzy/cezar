import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * Board phase 1c (spec `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c) against its own dry-run
 * server: the running beam and shimmer label, the `runner · account · model` top line, the
 * confirmed moves (cancel, finish, accept, run again), a refused drop, a Review reorder that
 * survives a reload, the ⋯ menu as the phone path, and the same on All boards.
 *
 * `CEZ_REVIEW_GATE=1`, as `review-gate.e2e.ts` pins it: the mock agent's first turn writes
 * `notes.md` in the task's worktree, so a finished run that changed files rests in Review. Four
 * slots (`maxParallel: 4`), so the waiting and reviewing runs never queue behind the slow one.
 *
 * Every drag is a real, trusted pointer stream on the card's HANDLE (`AgentBrowser.dragTo`) — the
 * only kind dnd-kit's pointer sensor accepts.
 *
 * Part D needs a multi-project registry, which only POSIX roots can enter
 * (`packages/cezar/src/workspace/config.ts:48`): it skips LOUDLY on win32 and under
 * `CEZ_SINGLE_PROJECT=1`, and runs on Linux.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-board-moves-${process.pid}`

const PART_D_SKIP =
  process.platform === 'win32'
    ? 'win32 — the workspace registry only stores POSIX roots (packages/cezar/src/workspace/config.ts:48), so no fixture project can be registered'
    : process.env.CEZ_SINGLE_PROJECT === '1'
      ? 'CEZ_SINGLE_PROJECT=1 — the server lists only the boot project'
      : null

if (PART_D_SKIP !== null) {
  const bar = '!'.repeat(78)
  // Straight to stderr: vitest does not print a `console.*` call made while it collects a file.
  process.stderr.write(
    `\n${bar}\n  board-moves.e2e.ts PART D (index-fed lanes) IS SKIPPED: ${PART_D_SKIP}.\n  Run it on Linux (WSL). A skip is not a pass.\n${bar}\n\n`,
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
  throw new Error(`cezar e2e: the board-moves server never answered at ${url}`)
}

async function startRun(url: string, task: string): Promise<string> {
  // AgentBrowser uses synchronous child-process calls. Yield before fetch so Node does not reuse
  // an idle keep-alive socket the server closed while the browser command blocked this worker.
  await new Promise<void>((r) => setTimeout(r, 50))
  const response = await fetch(`${url}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workflow: 'quick-task' }),
  })
  if (!response.ok) throw new Error(`cezar e2e: POST /runs answered ${response.status}`)
  return ((await response.json()) as { id: string }).id
}

/**
 * Poll until the run's status is one of `wanted`. `queued`/`running` — and whatever `from` names,
 * the status the test just acted on — are the only statuses worth waiting through; any other one
 * is a resting state that will not become `wanted`, so it fails now instead of timing out.
 */
async function waitForStatus(
  url: string,
  id: string,
  wanted: string[],
  { from = [], tries = 240 }: { from?: string[]; tries?: number } = {},
): Promise<string> {
  const transitional = new Set(['queued', 'running', ...from])
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const { status } = await getJson<{ status: string }>(`${url}/api/v1/runs/${id}`)
    if (wanted.includes(status)) return status
    if (!transitional.has(status)) {
      throw new Error(`cezar e2e: run ${id} ended as ${status}, wanted ${wanted.join('/')}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached ${wanted.join('/')}`)
}

/** One process of the suite's server tree, as the OS reports it. `created` tells a reused PID apart. */
interface TreeProcess {
  pid: number
  ppid: number
  created: string
  command: string
}

/** Every process on this machine, with its parent and creation time — from the OS, not from Node. */
function allProcesses(): TreeProcess[] {
  if (process.platform === 'win32') {
    const json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); command = [string]$_.CommandLine } }) | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    return JSON.parse(json) as TreeProcess[]
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), created: m[3]!, command: m[4]! }] : []
  })
}

/** `root` and everything below it, at this moment. */
function processTree(root: number): TreeProcess[] {
  const all = allProcesses()
  const tree = all.filter((p) => p.pid === root)
  for (let index = 0; index < tree.length; index += 1) {
    const parent = tree[index]!.pid
    tree.push(...all.filter((p) => p.ppid === parent && !tree.includes(p)))
  }
  return tree
}

const shell = (id: string) => `[data-slot="board-card-shell"][data-run-id="${id}"]`
const cardLink = (id: string) => `[data-slot="board-card"][data-run-id="${id}"]`

/** The per-project column a run's card sits in, read from the DOM — `null` when no card. */
const columnOf = (id: string): string =>
  `(document.querySelector('${cardLink(id)}')?.closest('[data-slot="board-column"]')?.dataset.column ?? null)`

/** The All-boards cell a run's card sits in — `null` when no card. */
const cellOf = (id: string): string =>
  `(document.querySelector('${cardLink(id)}')?.closest('[data-slot="board-cell"]')?.dataset.column ?? null)`

/**
 * The centre of an element's box, in viewport pixels — where a drag starts or ends. Read, never
 * scrolled to: scrolling to the target would move the handle measured a moment before, so every
 * drag here is laid out to fit the 1440×900 viewport.
 */
function centerOf(browser: AgentBrowser, selector: string, dy = 0): { x: number; y: number } {
  return browser.evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2 + ${dy}) } })()`,
  ) as { x: number; y: number }
}

/** Drag a card by its handle onto `target` (a selector), with a real pointer. */
function dragCard(browser: AgentBrowser, runId: string, target: string, dy = 0): void {
  const from = centerOf(browser, `${shell(runId)} [data-slot="board-card-handle"]`)
  const to = centerOf(browser, target, dy)
  browser.dragTo(from, to)
}

const DIALOG = '[data-slot="board-move-dialog"]'
const dialogAction = `(document.querySelector('${DIALOG}')?.dataset.action ?? null)`

let browser: AgentBrowser
let server: ChildProcess
let launched: TreeProcess[] = []
let dataRoot: string
let cezHome: string
let baseUrl: string
let bootProject: string
let boardUrl: string
/** Part D's fixture projects. Removed in the top-level `afterAll`, AFTER the server has stopped. */
let seedDir: string | undefined

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-board-moves-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# board-moves e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // The review gate is opt-in (#489); pinning it makes "changed files → Review" reproducible.
  const env = fixtureServeEnv(dataRoot, { CEZ_REVIEW_GATE: '1' })
  cezHome = env.CEZ_HOME as string
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ resources: { maxParallel: 4 } }), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env,
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    launched = processTree(server.pid!)
    if (launched.some((p) => p.pid === server.pid)) break
    await new Promise((r) => setTimeout(r, 25))
  }
  if (!launched.some((p) => p.pid === server.pid && p.ppid === process.pid)) {
    throw new Error(`cezar e2e: could not record the board-moves server process ${server.pid} at launch`)
  }
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  boardUrl = `${baseUrl}/p/${encodeURIComponent(bootProject)}/board`

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(boardUrl)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="board-column"]').length === 5`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  // The owner's process rule: record what this suite started — PID, creation time and command of
  // the server and every process below it, mock agents included — BEFORE ending it, then prove
  // none of it survived. A PID that comes back with another creation time is someone else's.
  let recorded: TreeProcess[] = []
  // Only signal the child while its launch identity still matches; a reused PID belongs to someone else.
  if (server?.pid !== undefined && server.exitCode === null && server.signalCode === null) {
    recorded = processTree(server.pid)
    const started = launched.find((p) => p.pid === server.pid)
    const current = recorded.find((p) => p.pid === server.pid)
    if (!started || !current || current.created !== started.created || current.ppid !== process.pid) {
      throw new Error(`cezar e2e: board-moves server ${server.pid} no longer matches its recorded launch identity`)
    }
    // Listen before killing, so the exit cannot be missed.
    const exited = new Promise<void>((done) => server.once('exit', () => done()))
    server.kill('SIGINT')
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

  // A killed tree takes a moment to go: look again for up to 5 s before calling anything a survivor.
  let survivors: TreeProcess[] = recorded
  for (let attempt = 0; attempt < 10 && survivors.length > 0; attempt += 1) {
    const alive = new Set(allProcesses().map((p) => `${p.pid}@${p.created}`))
    survivors = recorded.filter((p) => alive.has(`${p.pid}@${p.created}`))
    if (survivors.length > 0) await new Promise((r) => setTimeout(r, 500))
  }
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(
    join(artifactsDir, 'board-moves-processes.json'),
    `${JSON.stringify({ launched: { task: 'board-moves.e2e', pid: launched[0]?.pid, created: launched[0]?.created, command: launched[0]?.command, cwd: process.cwd(), parentPid: process.pid, cleanupOwner: 'board-moves.e2e afterAll' }, recorded, survivors }, null, 2)}\n`,
    'utf8',
  )
  // Reported, never killed here: what is left is for the owner to look at.
  if (survivors.length > 0) {
    throw new Error(
      `cezar e2e: board-moves left ${survivors.length} process(es) running: ${survivors.map((p) => `${p.pid} (${p.created}) ${p.command}`).join('; ')}`,
    )
  }
}, 120_000)

describe('part A — a running card, and who is on it', () => {
  let slow: string

  it('a running card wears the beam and a shimmering label, and its top line names the agent', async () => {
    // `mock:slow` holds its turn for ~25 s, and the cancel in the next test must land inside it:
    // everything from the start to that confirm is a handful of browser calls, and no screenshot.
    slow = await startRun(baseUrl, 'mock:slow R1 keeps working')
    await waitForStatus(baseUrl, slow, ['running'])
    // Dry run: no runner asked (the project default, claude), the discovered account, no model.
    browser.waitForFunction(
      `${columnOf(slow)} === 'running' && document.querySelector('${cardLink(slow)}')?.closest('[data-slot="running-beam"]') != null && document.querySelector('${shell(slow)} [data-slot="board-card-agent"]')?.textContent === 'claude · Default · auto'`,
    )
    const facts = browser.evaluate(`(() => {
      const card = document.querySelector('${shell(slow)}')
      // The ported keyframes must exist as a RULE — an inline animation name alone proves nothing.
      const keyframes = [...document.styleSheets].some((sheet) => {
        try {
          return [...sheet.cssRules].some((rule) => rule instanceof CSSKeyframesRule && rule.name === 'running-beam-dash')
        } catch {
          return false
        }
      })
      return {
        shimmer: card.querySelectorAll('[data-slot="board-card-status"] .shimmer-text').length,
        pulsing: card.querySelector('[data-slot="status-dot"]').classList.contains('animate-pulse'),
        keyframes,
        animation: getComputedStyle(card.closest('[data-slot="running-beam"]').querySelector('rect')).animationName,
        // The card's own border steps aside, so the beam's crisp line shows on the rim.
        border: getComputedStyle(card).borderTopColor,
      }
    })()`)
    expect(facts).toEqual({
      shimmer: 1,
      pulsing: false,
      keyframes: true,
      animation: 'running-beam-dash',
      border: 'rgba(0, 0, 0, 0)',
    })
  }, 120_000)

  it('Running → Not doing asks first, then cancels — the card moves only once the run is cancelled', async () => {
    dragCard(browser, slow, '[data-slot="board-column"][data-column="not-doing"]')
    // Not optimistic: until the confirm, the card is still where the run is.
    browser.waitForFunction(`${dialogAction} === 'cancel' && ${columnOf(slow)} === 'running'`)
    browser.click('[data-slot="board-move-confirm"]')
    await waitForStatus(baseUrl, slow, ['cancelled'])
    browser.waitForFunction(`${columnOf(slow)} === 'not-doing'`)
    browser.screenshot(`${artifactsDir}/board-1c-cancelled.png`)
  }, 120_000)

  it('an invalid drop snaps back with the reason', () => {
    dragCard(browser, slow, '[data-slot="board-column"][data-column="review"]')
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="toast"]')].some((t) => t.textContent === 'To run this task again, drop it on Queued.')`,
    )
    expect(browser.count(DIALOG)).toBe(0)
    expect(browser.evaluate(columnOf(slow))).toBe('not-doing')
    browser.screenshot(`${artifactsDir}/board-1c-refused.png`, { viewport: true })
  })

  it('Not doing → Queued runs it again as a new task, and the original stays in Not doing', async () => {
    const before = new Set((await getJson<Array<{ id: string }>>(`${baseUrl}/api/v1/runs`)).map((run) => run.id))
    dragCard(browser, slow, '[data-slot="board-column"][data-column="queued"]')
    browser.waitForFunction(`${dialogAction} === 'rerun'`)
    expect(browser.text(DIALOG)).toContain('Attachments are not copied.')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="toast"]').length === 0`)
    browser.screenshot(`${artifactsDir}/board-1c-confirm-rerun.png`, { viewport: true })
    browser.click('[data-slot="board-move-confirm"]')

    let again: string | undefined
    for (let attempt = 0; attempt < 60 && again === undefined; attempt += 1) {
      const runs = await getJson<Array<{ id: string; task: string }>>(`${baseUrl}/api/v1/runs`)
      again = runs.find((run) => !before.has(run.id) && run.task === 'mock:slow R1 keeps working')?.id
      if (again === undefined) await new Promise((r) => setTimeout(r, 500))
    }
    if (again === undefined) throw new Error('cezar e2e: Run again created no new run')
    // The new task is `mock:slow` too: while it works, it is the beam's screenshot.
    browser.waitForFunction(
      `${columnOf(again)} === 'running' && document.querySelector('${cardLink(again)}')?.closest('[data-slot="running-beam"]') != null`,
    )
    browser.waitForFunction(`document.querySelectorAll('[data-slot="toast"]').length === 0`)
    browser.screenshot(`${artifactsDir}/board-1c-running.png`)
    expect(browser.evaluate(columnOf(slow))).toBe('not-doing')
  }, 120_000)
})

describe('part B — Needs you, Review, and the saved order', () => {
  let parked: string

  it('Needs you → Done finishes the session; with the review gate on, the changed run waits in Review', async () => {
    parked = await startRun(baseUrl, 'R2 parks for you')
    await waitForStatus(baseUrl, parked, ['waiting'])
    browser.waitForFunction(`${columnOf(parked)} === 'needs-you'`)
    dragCard(browser, parked, '[data-slot="board-column"][data-column="done"]')
    browser.waitForFunction(`${dialogAction} === 'finish'`)
    browser.click('[data-slot="board-move-confirm"]')
    // Pending until the stream moves it: dimmed, "finishing…" — or already landed in Review.
    browser.waitForFunction(
      `document.querySelector('${shell(parked)}[data-pending="finish"]') !== null || ${columnOf(parked)} === 'review'`,
    )
    await waitForStatus(baseUrl, parked, ['review'], { from: ['waiting'] })
    browser.waitForFunction(`${columnOf(parked)} === 'review'`)
    // Announced politely, and the focus the old card took with it is on the moved card's ⋯.
    browser.waitForFunction(
      `(() => { const text = document.querySelector('[data-slot="board-move-announcer"]')?.textContent ?? ''; return text.startsWith('Finished “') && text.endsWith('” — moved to Review.') })()`,
    )
    browser.waitForFunction(
      `document.activeElement?.dataset.slot === 'board-card-menu' && document.activeElement.closest('[data-slot="board-card-shell"]')?.dataset.runId === '${parked}'`,
    )
  }, 120_000)

  it('Review → Done accepts the changes', async () => {
    dragCard(browser, parked, '[data-slot="board-column"][data-column="done"]')
    browser.waitForFunction(`${dialogAction} === 'accept'`)
    browser.click('[data-slot="board-move-confirm"]')
    await waitForStatus(baseUrl, parked, ['done'], { from: ['review'] })
    browser.waitForFunction(`${columnOf(parked)} === 'done'`)
    browser.screenshot(`${artifactsDir}/board-1c-accepted.png`)
  }, 120_000)

  it('reordering Review sticks across a reload (the project’s ui-state)', async () => {
    const older = await startRun(baseUrl, 'R3 older review')
    const newer = await startRun(baseUrl, 'R4 newer review')
    for (const id of [older, newer]) {
      await waitForStatus(baseUrl, id, ['waiting'])
      await fetch(`${baseUrl}/api/v1/runs/${id}/finish`, { method: 'POST' })
      await waitForStatus(baseUrl, id, ['review'], { from: ['waiting'] })
    }
    const reviewIds = `[...document.querySelectorAll('[data-slot="board-column"][data-column="review"] [data-slot="board-card"]')].map((c) => c.dataset.runId)`
    // Default order is newest first.
    browser.waitForFunction(`JSON.stringify(${reviewIds}) === ${JSON.stringify(JSON.stringify([newer, older]))}`)

    // The older card onto the top half of the newer one: it takes that place.
    dragCard(browser, older, shell(newer), -12)
    browser.waitForFunction(`JSON.stringify(${reviewIds}) === ${JSON.stringify(JSON.stringify([older, newer]))}`)
    let saved: unknown
    for (let attempt = 0; attempt < 20; attempt += 1) {
      saved = (await getJson<{ board?: { order?: { review?: string[] } } }>(`${baseUrl}/api/v1/ui-state`)).board?.order?.review
      if (JSON.stringify(saved) === JSON.stringify([older, newer])) break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(saved).toEqual([older, newer])

    browser.goto(boardUrl)
    browser.waitForFunction(`JSON.stringify(${reviewIds}) === ${JSON.stringify(JSON.stringify([older, newer]))}`)
    browser.screenshot(`${artifactsDir}/board-1c-reordered.png`)
  }, 180_000)

  it('the server bounds the saved order and keeps `board` keys it does not know', async () => {
    const put = async (body: unknown) => {
      await new Promise<void>((r) => setTimeout(r, 50))
      return fetch(`${baseUrl}/api/v1/ui-state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    expect((await put({ board: { order: { review: ['x'.repeat(65)] } } })).status).toBe(400)
    const current = await getJson<{ board?: { order?: Record<string, string[]> } }>(`${baseUrl}/api/v1/ui-state`)
    const kept = await put({ board: { ...current.board, laterKey: { a: 1 } } })
    expect(kept.status).toBe(200)
    expect(((await kept.json()) as { board: Record<string, unknown> }).board.laterKey).toEqual({ a: 1 })
  })

  it('on a phone there is no drag handle, and the ⋯ menu offers the same actions', () => {
    browser.setViewport(390, 844)
    try {
      browser.waitForFunction(`document.querySelectorAll('[data-slot="board-card-handle"]').length === 0`)
      browser.click(`${shell(parked)} [data-slot="board-card-menu"]`)
      browser.waitForFunction(`document.querySelector('[data-slot="board-card-action"][data-action="rerun"]') !== null`)
      browser.screenshot(`${artifactsDir}/board-1c-mobile-menu.png`, { viewport: true })
      browser.click('[data-slot="board-card-action"][data-action="rerun"]')
      browser.waitForFunction(`${dialogAction} === 'rerun'`)
      browser.click('[data-slot="board-move-keep"]')
      browser.waitForFunction(`document.querySelector('${DIALOG}') === null`)
    } finally {
      // Whatever happened above, parts C and D drag at the desktop size.
      browser.setViewport(1440, 900)
    }
  })
})

describe('part C — All boards: the boot lane (every platform)', () => {
  it('names each card’s agent, and a cancel inside the lane works', async () => {
    const lane = `[data-slot="board-lane"][data-project-id="${bootProject}"]`
    browser.goto(`${baseUrl}/board`)
    browser.waitForFunction(`document.querySelector('[data-slot="all-boards"]') !== null`)
    const working = await startRun(baseUrl, 'mock:slow R5 on all boards')
    await waitForStatus(baseUrl, working, ['running'])
    browser.waitForFunction(`${cellOf(working)} === 'running'`)
    // Windows: the boot lane is the unregistered folder's own records; Linux: the runs index —
    // whose rows carry the server-derived runner and account (phase 1c).
    browser.waitForFunction(
      `document.querySelector('${shell(working)} [data-slot="board-card-agent"]')?.textContent === 'claude · Default · auto'`,
    )
    dragCard(browser, working, `${lane} [data-slot="board-cell"][data-column="not-doing"]`)
    browser.waitForFunction(`${dialogAction} === 'cancel'`)
    browser.click('[data-slot="board-move-confirm"]')
    await waitForStatus(baseUrl, working, ['cancelled'])
    browser.waitForFunction(`${cellOf(working)} === 'not-doing'`)
    browser.screenshot(`${artifactsDir}/board-1c-all-boards.png`)
  }, 120_000)
})

describe.skipIf(PART_D_SKIP !== null)('part D — index-fed lanes of registered projects (Linux)', () => {
  const X = { id: 'e2e-moves-x', name: 'moves x' }
  const Y = { id: 'e2e-moves-y', name: 'moves y' }
  const laneOf = (id: string) => `[data-slot="board-lane"][data-project-id="${id}"]`

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cezar-e2e-board-moves-lanes-'))
    seedDir = dir
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
    // Only resting states: a `running`/`queued`/`waiting` row on disk reads back as `failed`.
    const record = (id: string, status: 'review' | 'done', extra: Record<string, unknown> = {}) => ({
      id,
      title: id,
      workflow: 'quick-task',
      task: id,
      status,
      createdAt: hoursAgo(2),
      startedAt: hoursAgo(2),
      finishedAt: hoursAgo(1),
      tokensUsed: 0,
      archived: false,
      steps: [],
      ...extra,
    })
    const seedRepo = (id: string, runs: unknown[]): string => {
      const root = join(dir, id)
      execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
      mkdirSync(join(root, '.ai', 'cezar'), { recursive: true })
      writeFileSync(join(root, '.ai', 'cezar', 'runs.json'), JSON.stringify(runs), 'utf8')
      return realpathSync(root)
    }
    const entry = (project: { id: string; name: string }, root: string) => ({
      ...project,
      root,
      addedAt: '2026-07-01T00:00:00.000Z',
      lastOpenedAt: '2026-07-20T12:00:00.000Z',
      source: 'local' as const,
    })
    const x = entry(
      X,
      seedRepo(X.id, [
        record('seed-x-codex', 'review', {
          model: 'gpt-5.2-codex',
          steps: [
            { id: 'task', name: 'task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex', profileId: 'default' },
          ],
        }),
      ]),
    )
    const y = entry(Y, seedRepo(Y.id, [record('seed-y-done', 'done')]))
    const configPath = join(cezHome, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { projects?: unknown[] } & Record<string, unknown>
    writeFileSync(configPath, `${JSON.stringify({ ...config, projects: [...(config.projects ?? []), x, y] }, null, 2)}\n`, {
      mode: 0o600,
    })
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}/board`)
    browser.waitForFunction(`document.querySelector('${laneOf(X.id)}') !== null && document.querySelector('${laneOf(Y.id)}') !== null`)
  }, 120_000)

  it('an index-fed card names the agent its last step ran on', () => {
    browser.waitForFunction(
      `document.querySelector('${shell('seed-x-codex')} [data-slot="board-card-agent"]')?.textContent === 'codex · Default · gpt-5.2-codex'`,
    )
  })

  it('a card dropped in another project’s lane snaps back — and the same drag in its own lane does ask', () => {
    // Fold the boot lane (parts A–C filled it) so lanes X and Y both sit inside the viewport.
    if (browser.evaluate(`document.querySelector('${laneOf(bootProject)} [data-slot="board-lane-toggle"]')?.getAttribute('aria-expanded')`) === 'true') {
      browser.click(`${laneOf(bootProject)} [data-slot="board-lane-toggle"]`)
    }
    browser.click(`${laneOf(Y.id)} [data-slot="board-lane-toggle"]`)
    browser.waitForFunction(`document.querySelector('${laneOf(Y.id)} [data-slot="board-cell"][data-column="done"]')?.offsetParent != null`)
    dragCard(browser, 'seed-x-codex', `${laneOf(Y.id)} [data-slot="board-cell"][data-column="done"]`)
    browser.waitForFunction(`${cellOf('seed-x-codex')} === 'review'`)
    expect(browser.count(DIALOG)).toBe(0)
    expect(
      browser.evaluate(`document.querySelector('${cardLink('seed-x-codex')}')?.closest('[data-slot="board-lane"]')?.dataset.projectId`),
    ).toBe(X.id)
    // A drag that never started would leave the card in place too. The same drag onto its OWN
    // lane's Done must ask to accept — so the drag above was real, and only its target refused it.
    dragCard(browser, 'seed-x-codex', `${laneOf(X.id)} [data-slot="board-cell"][data-column="done"]`)
    browser.waitForFunction(`${dialogAction} === 'accept'`)
    browser.screenshot(`${artifactsDir}/board-1c-lanes.png`)
    browser.click('[data-slot="board-move-keep"]')
    browser.waitForFunction(`document.querySelector('${DIALOG}') === null && ${cellOf('seed-x-codex')} === 'review'`)
  })
})
