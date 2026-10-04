import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * Hosted agent accounts, phase H1 (spec `.ai/specs/2026-10-04-hosted-agent-accounts.md`): a cockpit
 * that is not on the local machine lists every agent account READ-ONLY — label and signed-in state,
 * never a folder — and the composer can pick any of them for one task.
 *
 * Its own dry-run server, `CEZ_REMOTE=1`, its own `CEZ_HOME`, holding one stored Claude account
 * ("Work") whose folder deliberately does NOT exist. Absent `exists` means "not disclosed"; a
 * consumer that tested it for falsiness would print "folder not created yet", so every surface is
 * checked for that string. Runs on every platform, Windows included.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-hosted-accounts-list-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
/** This suite's own `CEZ_HOME`: where `agent-accounts.json` lives. */
let cezHome: string
let baseUrl: string
let bootProject: string
/** Every folder this suite's server knows and must never send to a client. */
let hiddenPaths: string[] = []
/** The boot project's own account choice, keyed by its realpath'd root — served back as it is. */
let seededSelections: Record<string, Record<string, string>> = {}

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
  throw new Error(`cezar e2e: the hosted-accounts server never answered at ${url}`)
}

/** The spellings a path can take in a page or a JSON body: as is, JSON-escaped, forward-slashed. */
function spellings(path: string): string[] {
  return [path, JSON.stringify(path).slice(1, -1), path.replaceAll('\\', '/')]
}

/** Which hidden folders `text` carries — `[]` is the only passing answer. */
function leaks(text: string): string[] {
  return hiddenPaths.filter((path) => spellings(path).some((spelling) => text.includes(spelling)))
}

const html = (): string => String(browser.evaluate('document.documentElement.outerHTML'))
const pageText = (): string => String(browser.evaluate('document.body.innerText'))

/**
 * Let Node's event loop run once. This suite drives the browser through SYNCHRONOUS calls
 * (`execFileSync`) and starts its server in a slow `beforeAll`, which block the loop for seconds: the
 * server meanwhile closes the idle keep-alive socket Node's fetch pooled, and the next request goes
 * out on that dead socket before the loop has noticed it close — `ECONNRESET` with no response, a
 * dead connection and never a dead server. Yielding first lets the loop drop the closed socket, so
 * the request opens a fresh one. (`connection: close` on the request does NOT avoid this — the pool
 * still hands out the dead socket — and an immediate `setImmediate` is too short.)
 */
const settle = () => new Promise<void>((r) => setTimeout(r, 50))

/**
 * One request, answered with its status and raw text. It yields first (see `settle`), so no request
 * has to be re-sent. A mutation is NEVER retried — it could be applied twice. A GET is retried once
 * around `fetch()` itself, never around reading the body.
 */
async function send(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  await settle()
  const init = {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }
  let response: Response
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${path}`, init)
      break
    } catch (error) {
      const reset = (error as { cause?: { code?: string } }).cause?.code === 'ECONNRESET'
      if (method !== 'GET' || !reset || attempt >= 1) throw error
      await settle()
    }
  }
  return { status: response.status, text: await response.text() }
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-hosted-list-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# hosted accounts e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // `CEZ_REMOTE` and `CEZ_HOSTED_ACCOUNTS` are pinned explicitly: `fixtureServeEnv` copies this
  // process's env, so whatever the operator exported must not decide which mode this suite tests.
  const env = fixtureServeEnv(dataRoot, { CEZ_REMOTE: '1', CEZ_HOSTED_ACCOUNTS: '0' })
  cezHome = env.CEZ_HOME as string
  mkdirSync(cezHome, { recursive: true })
  // Never created: the folder of a hand-added account the CLI has not written yet.
  const workDir = join(dataRoot, 'claude-work-account')
  // Keyed the way the server keys a project: its realpath'd root. On Linux that is the boot project,
  // so the composer starts on "Work" there; on Windows the cockpit spells the root differently and
  // falls back to Default — either way the listing must serve this map back unchanged.
  seededSelections = { [realpathSync(dataRoot)]: { claude: 'work' } }
  writeFileSync(
    join(cezHome, 'agent-accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'work', provider: 'claude', configDir: workDir, label: 'Work', addedAt: '2026-10-04T00:00:00.000Z' },
      ],
      selections: seededSelections,
      defaults: {},
    }),
    'utf8',
  )
  // The discovered accounts' folders, resolved the way `agentHomePaths()` does from this same env.
  const home = env.HOME || env.USERPROFILE || homedir()
  hiddenPaths = [
    workDir,
    env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
    env.CODEX_HOME?.trim() || join(home, '.codex'),
  ]

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
    let timer: NodeJS.Timeout | undefined
    const gaveUp = new Promise<void>((done) => {
      timer = setTimeout(done, 10_000)
    })
    await Promise.race([exited, gaveUp])
    clearTimeout(timer)
  }
  // Windows keeps the killed server's handles for a beat — retry instead of failing on EBUSY.
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}, 90_000)

describe('hosted agent accounts — the read-only list (H1)', () => {
  it('lists every account without its folder, its existence or a way to manage it', async () => {
    const response = await send('GET', '/api/v1/workspace/agent-profiles')
    expect(response.status).toBe(200)
    const raw = response.text
    const body = JSON.parse(raw) as {
      editable: boolean
      manageable: boolean
      profiles: Array<Record<string, unknown> & { id: string; provider: string; status?: { status: string } }>
      selections: Record<string, Record<string, string>>
    }
    expect(body.editable).toBe(false)
    expect(body.manageable).toBe(false)
    // Only a root a hosted client already holds is served: a registered project's, or the boot
    // folder's (`/repo` serves it). This is the boot repo — registered on POSIX, where the registry
    // can hold its root, and served as the boot folder on Windows, where it cannot.
    expect(body.selections).toEqual(seededSelections)
    expect(body.profiles.find((p) => p.id === 'work')).toMatchObject({
      provider: 'claude',
      label: 'Work',
      isDefault: false,
      // Dry run answers every probe `connected`; what this pins is that the listing SERVES a status.
      status: { status: 'connected' },
    })
    for (const profile of body.profiles) {
      for (const hidden of ['configDir', 'path', 'files', 'exists', 'looksValid']) {
        expect(profile, `${profile.provider}:${profile.id}`).not.toHaveProperty(hidden)
      }
    }
    expect(leaks(raw)).toEqual([])
  })

  it('still refuses the per-account status probe — it can spawn a CLI, so it is not read-only', async () => {
    for (const id of ['work', 'default:claude']) {
      const response = await send('GET', `/api/v1/workspace/agent-profiles/${encodeURIComponent(id)}/status`)
      expect(response.status, id).toBe(409)
    }
  })

  it('Settings → Agent accounts shows the rows: label and status, no folder, no action', () => {
    browser.goto(`${baseUrl}/settings/global/accounts`)
    browser.waitForFunction(`document.querySelector('[data-slot="account-row"][data-account="work"]') !== null`)
    const work = '[data-slot="account-row"][data-account="work"]'
    expect(browser.text(work)).toContain('Work')
    expect(browser.text(`${work} [data-slot="account-status"]`)).toBe('Connected')
    expect(browser.count('[data-slot="account-path"]')).toBe(0)
    expect(browser.count('[data-slot="account-missing"]')).toBe(0)
    for (const action of ['accounts-add', 'account-connect', 'account-recheck', 'account-details-toggle']) {
      expect(browser.count(`[data-action="${action}"]`), action).toBe(0)
    }
    expect(browser.text('[data-slot="accounts-readonly"]')).toContain('Account management is off')
    expect(pageText()).not.toContain('folder not created yet')
    expect(leaks(html())).toEqual([])
    // The rows sit below the tall "Defaults for new projects" block, in a pane that scrolls inside
    // the app shell, so a capture at the suite's viewport shows only the defaults and never the
    // rows this test is about. A taller viewport frames the notice, the defaults and the rows at once.
    browser.setViewport(1440, 1800)
    try {
      browser.screenshot(`${artifactsDir}/hosted-accounts-list.png`, { viewport: true })
    } finally {
      browser.setViewport(1440, 900)
    }
  })

  it('a Default login keeps its name without the flag: no Rename, and PATCH is refused before it resolves', async () => {
    // Still on Settings → Agent accounts (the case above).
    expect(browser.count('[data-action="account-rename"]')).toBe(0)
    const accountsFile = join(cezHome, 'agent-accounts.json')
    const before = readFileSync(accountsFile, 'utf8')
    // A PATCH is never retried — `send` yields first instead (see `settle`).
    const patch = async (id: string, payload: unknown) => {
      const response = await send('PATCH', `/api/v1/workspace/agent-profiles/${encodeURIComponent(id)}`, payload)
      return { status: response.status, body: JSON.parse(response.text) as unknown }
    }
    const refused = await patch('default:claude', { label: 'Personal Max' })
    expect(refused.status).toBe(409)
    // The same answer for an id that names nothing, and for a body the route would refuse anyway:
    // the gate answers first, so a refusal says nothing about which ids exist.
    expect(await patch('default:nope', { label: 'Personal Max' })).toEqual(refused)
    expect(await patch('default:claude', { configDir: join(dataRoot, 'x') })).toEqual(refused)
    expect(readFileSync(accountsFile, 'utf8')).toBe(before)
    const listed = await getJson<{ profiles: Array<{ provider: string; isDefault: boolean; label: string }> }>(
      `${baseUrl}/api/v1/workspace/agent-profiles`,
    )
    expect(listed.profiles.find((p) => p.provider === 'claude' && p.isDefault)?.label).toBe('Default')
  })

  // The two defaults pickers: `scope` is the machine-wide block on Settings → Agent accounts, or ''
  // for the project's own Settings → Agents.
  const machine = '[data-slot="accounts-defaults"]'
  const radio = (scope: string, runner: string) =>
    `${scope} [data-slot="agents-runner"] [role="radio"][data-value="${runner}"]`
  // EVERY row is disabled while provider status loads (and the project's account rows while the
  // registry loads), so a check made then would pass for the wrong reason. The single-login codex
  // row turns enabled exactly when provider status has arrived.
  const ready = (scope: string) => `document.querySelector(${JSON.stringify(radio(scope, 'codex'))})?.disabled === false`
  // The Claude rows, as "<in force?>:<state>". In force is the checked row (claude is the default
  // runner here): it must stay ENABLED — picking it changes the runner only — and every other
  // account row must be disabled. Sorted, so the order of the rows does not matter.
  const claudeRows = (scope: string) =>
    `[...document.querySelectorAll(${JSON.stringify(radio(scope, 'claude'))})].map((r) => (r.getAttribute('aria-checked') === 'true' ? 'in-force' : 'other') + ':' + (r.disabled ? 'disabled' : 'enabled')).sort().join(',')`
  const readOnly = "'in-force:enabled,other:disabled'"

  it('both defaults pickers keep the account read-only — only the account in force stays pickable', () => {
    // Settings → Agent accounts → "Defaults for new projects" (the machine-wide default).
    browser.waitForFunction(ready(machine))
    browser.waitForFunction(`${claudeRows(machine)} === ${readOnly}`)
    expect(browser.count('[data-slot="accounts-defaults"] [data-slot="agents-account-readonly"]')).toBe(1)

    // The project's own Settings → Agents.
    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    browser.waitForFunction(ready(''))
    browser.waitForFunction(`${claudeRows('')} === ${readOnly}`)
    expect(browser.count('[data-slot="agents-account-readonly"]')).toBe(1)
    expect(browser.count('[data-slot="agents-account-missing"]')).toBe(0)
    expect(pageText()).not.toContain('folder not created yet')
    expect(leaks(html())).toEqual([])
    // The defaults list and its read-only hint sit below the provider cards, inside the scrolling
    // pane: frame them rather than the top of the page.
    browser.evaluate(
      `document.querySelector('[data-slot="agents-account-readonly"]').scrollIntoView({ block: 'center' })`,
    )
    browser.screenshot(`${artifactsDir}/hosted-accounts-list-agents.png`, { viewport: true })
  })

  it('picking the account in force changes the runner and writes no selection', async () => {
    // On a cockpit that does not manage accounts the account in force is the one row still
    // pickable. Picking it must write the runner ALONE: a selection write would answer 409, which
    // the page shows as a danger toast, and it would touch `agent-accounts.json`.
    const accountsFile = join(cezHome, 'agent-accounts.json')
    const before = readFileSync(accountsFile, 'utf8')
    const checked = (selector: string) =>
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked') === 'true'`
    const machineRunner = async () =>
      (await getJson<{ agentDefaults: { runner?: string } }>(`${baseUrl}/api/v1/workspace/config`)).agentDefaults.runner
    const projectRunner = async () =>
      (await getJson<{ defaultRunner: string }>(`${baseUrl}/api/v1/config`)).defaultRunner

    for (const { name, scope, url, read } of [
      { name: 'machine', scope: machine, url: `${baseUrl}/settings/global/accounts`, read: machineRunner },
      { name: 'project', scope: '', url: `${baseUrl}/p/${bootProject}/settings/agents`, read: projectRunner },
    ]) {
      browser.goto(url)
      browser.waitForFunction(ready(scope))
      browser.waitForFunction(`${claudeRows(scope)} === ${readOnly}`)
      // The account in force is the one Claude row left enabled; where that is Default or Work
      // depends on the platform (see `seededSelections`), so it is read from the page.
      const inForce = String(
        browser.evaluate(
          `document.querySelector(${JSON.stringify(`${radio(scope, 'claude')}:not([disabled])`)})?.getAttribute('data-account') ?? 'none'`,
        ),
      )
      expect(inForce, name).not.toBe('none')
      const claude = `${radio(scope, 'claude')}[data-account="${inForce}"]`

      // Away to the single-login agent and back onto the account in force: the runner moves each
      // time, and the API says so.
      browser.click(radio(scope, 'codex'))
      browser.waitForFunction(checked(radio(scope, 'codex')))
      expect(await read(), `${name}: codex saved`).toBe('codex')
      browser.click(claude)
      browser.waitForFunction(checked(claude))
      expect(await read(), `${name}: claude saved`).toBe('claude')

      // A refused write would have surfaced by now: both writes were issued from one click handler.
      await new Promise((r) => setTimeout(r, 500))
      expect(browser.count('[data-slot="toast"][data-tone="danger"]'), `${name}: danger toast`).toBe(0)
      // The project's list starts below the fold of its pane: frame the row that was just picked.
      browser.evaluate(`document.querySelector(${JSON.stringify(claude)}).scrollIntoView({ block: 'center' })`)
      browser.screenshot(`${artifactsDir}/hosted-accounts-list-in-force-${name}.png`, { viewport: true })
    }
    expect(readFileSync(accountsFile, 'utf8')).toBe(before)
  }, 90_000)

  it('the composer offers every Claude login, and the one picked is the run’s account', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    // The pill renders before the runners load, disabled (`disabled={!providersReady}`); a click
    // then opens nothing.
    browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.disabled === false`)
    browser.click('[data-slot="runner-pill"]')
    browser.waitForFunction(`document.querySelector('[data-testid="runner-pill-menu"]') !== null`)
    const options = browser.evaluate(
      `[...document.querySelectorAll('[data-testid="runner-pill-menu"] [role="menuitemradio"]')].map((n) => n.textContent.trim())`,
    ) as string[]
    expect(options).toEqual(expect.arrayContaining(['claude · Default', 'claude · Work']))
    expect(leaks(html())).toEqual([])
    browser.screenshot(`${artifactsDir}/hosted-accounts-list-composer.png`, { viewport: true })

    // Per-task pick (owner decision 2026-10-04): any account, for this one task.
    browser.click('[data-testid="runner-pill-menu"] [data-value="claude:work"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="runner-pill"]')?.textContent.trim() === 'claude · Work'`,
    )
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'mock:done hosted account pick')
    browser.click('[aria-label="Start task"]')
    browser.waitForFunction(`location.pathname.startsWith('/p/${bootProject}/tasks/')`)
    const runId = String(browser.evaluate(`location.pathname.split('/').pop()`))
    const record = await getJson<{ runner?: string; agentProfile?: string }>(`${baseUrl}/api/v1/runs/${runId}`)
    expect(record.agentProfile).toBe('work')
    // `runner` is sent only when it differs from the repo default (`runnerOverride`); absent IS claude.
    expect(record.runner ?? 'claude').toBe('claude')
  }, 90_000)
})
