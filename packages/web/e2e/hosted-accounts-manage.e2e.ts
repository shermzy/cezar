import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * Hosted agent accounts, phase H2 (spec `.ai/specs/2026-10-04-hosted-agent-accounts.md`): with
 * `CEZ_HOSTED_ACCOUNTS=1` a hosted cockpit manages its agent accounts — add (cezar allocates a fresh
 * folder), rename, re-check, show details, assign, remove — and never takes or returns a path. It
 * also renames a Default login (spec § Renaming the Default logins), which changes its name and
 * nothing that chooses it.
 *
 * Part A runs everywhere, Windows included, and assigns through the MACHINE-WIDE default
 * (`projectId: null`), which needs no project. Part B assigns one PROJECT's account, which needs a
 * registered project — and only POSIX roots can be registered
 * (`packages/cezar/src/workspace/config.ts:48`) — so it skips LOUDLY on win32 and runs on Linux.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-hosted-accounts-manage-${process.pid}`

/** Why part B cannot run here, or `null` when it can. */
const PART_B_SKIP =
  process.platform === 'win32'
    ? 'win32 — the workspace registry only stores POSIX roots (packages/cezar/src/workspace/config.ts:48), so PUT …/selection with a projectId answers 404 here, in local mode too'
    : process.env.CEZ_SINGLE_PROJECT === '1'
      ? 'CEZ_SINGLE_PROJECT=1 — the server lists only the boot project'
      : null

if (PART_B_SKIP !== null) {
  const bar = '!'.repeat(78)
  // Straight to stderr: vitest does not print a `console.*` call made while it collects a file.
  process.stderr.write(
    `\n${bar}\n  hosted-accounts-manage.e2e.ts PART B (a project's own account) IS SKIPPED: ${PART_B_SKIP}.\n  Run it on Linux: in WSL (Ubuntu), as the plan's WSL step does. A skip is not a pass.\n${bar}\n\n`,
  )
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let cezHome: string
let baseUrl: string
let bootProject: string
/** `<CEZ_HOME>/accounts/claude` — where cezar allocates every hosted Claude account. */
let claudeAccounts: string
/** Every folder this suite's server knows and must never send to a client. */
let hiddenPaths: string[] = []

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

function spellings(path: string): string[] {
  return [path, JSON.stringify(path).slice(1, -1), path.replaceAll('\\', '/')]
}

function leaks(text: string): string[] {
  return hiddenPaths.filter((path) => spellings(path).some((spelling) => text.includes(spelling)))
}

const html = (): string => String(browser.evaluate('document.documentElement.outerHTML'))

/**
 * A capture of Settings → Agent accounts. The login rows sit below the tall "Defaults for new
 * projects" block, in a pane that scrolls inside the app shell, so a capture at the suite's viewport
 * shows only the defaults and never the rows a check is about. A taller viewport frames the defaults
 * and the rows at once.
 */
function screenshotAccounts(name: string): void {
  browser.setViewport(1440, 1800)
  try {
    browser.screenshot(`${artifactsDir}/${name}`, { viewport: true })
  } finally {
    browser.setViewport(1440, 900)
  }
}

type Listing = {
  editable: boolean
  manageable: boolean
  profiles: Array<Record<string, unknown> & { id: string; provider: string; label: string }>
  selections: Record<string, Record<string, string>>
  defaults: Record<string, string>
}

const listing = () => getJson<Listing>(`${baseUrl}/api/v1/workspace/agent-profiles`)

/**
 * Let Node's event loop run once. This suite drives the browser through SYNCHRONOUS calls
 * (`execFileSync`), which block the loop for seconds: the server meanwhile closes the idle keep-alive
 * socket Node's fetch pooled, and the next request goes out on that dead socket before the loop has
 * noticed it close — `ECONNRESET` with no response, a dead connection and never a dead server.
 * Yielding first lets the loop drop the closed socket, so the request opens a fresh one. (Checked
 * against a server that idles it out: `connection: close` on the request does NOT avoid this — the
 * pool still hands out the dead socket — and an immediate `setImmediate` is too short.)
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
  const text = await response.text()
  // A mutation never answers with a folder, whatever its status: every answer is scanned.
  if (method !== 'GET') expect(leaks(text)).toEqual([])
  return { status: response.status, text }
}

/** Poll the listing until `check` holds — writes land through the cockpit's own mutations. */
async function waitForListing(check: (body: Listing) => boolean, what: string): Promise<Listing> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = await listing()
    if (check(body)) return body
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the listing never showed ${what}`)
}

const row = (id: string) => `[data-slot="account-row"][data-account="${id}"]`
/** The Claude Default login's row. Every Default row has `data-account="default"`, so it is found
 *  inside its agent's tab. */
const claudeDefault = `[data-slot="accounts-provider"][data-provider="claude"] ${row('default')}`
/** The Claude Default login in the machine-wide defaults picker (a Default row's `data-account` is ''). */
const claudeDefaultPick = `[data-slot="accounts-defaults"] [data-slot="agents-runner"] [role="radio"][data-value="claude"][data-account=""]`

/** What renaming a Default login must leave alone: every stored account, and every choice naming one. */
function choicesOnDisk(): { accounts: unknown; selections: unknown; defaults: unknown } {
  const store = JSON.parse(readFileSync(join(cezHome, 'agent-accounts.json'), 'utf8'))
  return { accounts: store.accounts, selections: store.selections, defaults: store.defaults }
}

/** The name the listing gives `provider`'s Default login. */
async function defaultLabel(provider: string): Promise<string | undefined> {
  return (await listing()).profiles.find((p) => p.provider === provider && p.isDefault)?.label
}

/** Open the Claude Default login's details and start renaming it. */
function startRenamingClaudeDefault(): void {
  browser.goto(`${baseUrl}/settings/global/accounts`)
  browser.waitForFunction(`document.querySelector('${claudeDefault} [data-action="account-details-toggle"]') !== null`)
  // With one login the toggle sits on the viewport's bottom edge (top at 895 of 900 px): partly
  // visible, so the browser does not scroll it, and a click at its centre lands off screen and
  // does nothing — while reporting success. Frame it first, as the H1 suite does for its rows.
  browser.evaluate(`document.querySelector('${claudeDefault} [data-action="account-details-toggle"]').scrollIntoView({ block: 'center' })`)
  browser.click(`${claudeDefault} [data-action="account-details-toggle"]`)
  browser.waitForFunction(`document.querySelector('${claudeDefault} [data-action="account-rename"]') !== null`)
  // What cezar discovered can be renamed, never removed.
  expect(browser.count(`${claudeDefault} [data-action="account-remove"]`)).toBe(0)
  browser.click(`${claudeDefault} [data-action="account-rename"]`)
  browser.waitForFunction(`document.querySelector('${claudeDefault} [data-slot="account-rename-input"]') !== null`)
}

/** Add a Claude account through the cockpit's own dialog, and wait for its row. */
function addThroughDialog(name: string, expectedId: string): void {
  browser.click('[data-action="accounts-add"][data-provider="claude"]')
  browser.waitForFunction(`document.querySelector('[data-slot="add-account-dialog"]') !== null`)
  // Hosted: the name is the only input — there is no folder field to type a path into.
  expect(browser.count('[data-slot="add-account-dir"]')).toBe(0)
  browser.fill('[data-slot="add-account-label"]', name)
  browser.click('[data-slot="add-account-confirm"]')
  browser.waitForFunction(
    `document.querySelector('[data-slot="add-account-dialog"]') === null && document.querySelector('${row(expectedId)}') !== null`,
  )
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-hosted-manage-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# hosted accounts e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const env = fixtureServeEnv(dataRoot, { CEZ_REMOTE: '1', CEZ_HOSTED_ACCOUNTS: '1' })
  cezHome = env.CEZ_HOME as string
  mkdirSync(cezHome, { recursive: true })
  claudeAccounts = join(cezHome, 'accounts', 'claude')
  const home = env.HOME || env.USERPROFILE || homedir()
  hiddenPaths = [cezHome, env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), env.CODEX_HOME?.trim() || join(home, '.codex')]

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
  if (server?.pid !== undefined && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((done) => server.once('exit', () => done()))
    if (process.platform === 'win32') {
      // The tree this suite spawned itself — `server.kill()` alone orphans the dry-run mocks.
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
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}, 90_000)

describe('part A — managing accounts on a hosted cockpit (every platform)', () => {
  it('says it may manage, refuses a typed folder, and requires a name', async () => {
    const before = await listing()
    expect(before).toMatchObject({ editable: false, manageable: true })

    const typed = await send('POST', '/api/v1/workspace/agent-profiles', {
      provider: 'claude',
      label: 'Typed',
      configDir: join(dataRoot, 'claude-typed'),
    })
    expect(typed.status).toBe(400)
    expect(JSON.parse(typed.text)).toEqual({ error: 'configDir is allocated by cezar in hosted mode' })

    const nameless = await send('POST', '/api/v1/workspace/agent-profiles', { provider: 'claude' })
    expect(nameless.status).toBe(400)
    expect(JSON.parse(nameless.text)).toEqual({ error: 'label is required in hosted mode' })

    // Neither refusal wrote anything or allocated a folder.
    expect((await listing()).profiles.filter((p) => !p.isDefault)).toEqual([])
    expect(existsSync(join(cezHome, 'accounts'))).toBe(false)
  })

  it('adds "Work 2": cezar allocates a fresh folder, and neither the answer nor the page names it', async () => {
    browser.goto(`${baseUrl}/settings/global/accounts`)
    browser.waitForFunction(`document.querySelector('[data-action="accounts-add"][data-provider="claude"]') !== null`)
    addThroughDialog('Work 2', 'work-2')

    expect(existsSync(join(claudeAccounts, 'work-2'))).toBe(true)
    const raw = await send('GET', '/api/v1/workspace/agent-profiles')
    expect(leaks(raw.text)).toEqual([])
    expect(JSON.parse(raw.text).profiles.find((p: { id: string }) => p.id === 'work-2')).not.toHaveProperty('configDir')
    expect(browser.count('[data-slot="account-path"]')).toBe(0)
    expect(browser.count('[data-action="account-connect"]')).toBe(0)
    expect(leaks(html())).toEqual([])
    screenshotAccounts('hosted-accounts-manage.png')
  })

  it('renames it, shows who it is signed in as, and keeps its folder where it was', () => {
    browser.click(`${row('work-2')} [data-action="account-details-toggle"]`)
    browser.waitForFunction(`document.querySelector('${row('work-2')} [data-action="account-rename"]') !== null`)
    // The details route is open here: a fresh folder holds no login yet, and says so.
    browser.waitForFunction(`document.querySelector('${row('work-2')} [data-slot="account-identity-unavailable"]') !== null`)
    expect(browser.text(`${row('work-2')} [data-slot="account-identity-unavailable"]`)).toContain('Not signed in')
    // Files and the folder are paths: no "Config files" strip on a hosted row.
    expect(browser.count('[data-slot="account-open-folder"]')).toBe(0)

    browser.click(`${row('work-2')} [data-action="account-rename"]`)
    browser.fill('[data-slot="account-rename-input"]', 'Work Two')
    browser.click('[data-action="account-rename-save"]')
    browser.waitForFunction(`document.querySelector('${row('work-2')}')?.textContent.includes('Work Two') === true`)
    expect(existsSync(join(claudeAccounts, 'work-2'))).toBe(true)
    expect(leaks(html())).toEqual([])
  })

  it('re-checks it on demand — the status route is open with management on', async () => {
    browser.click(`${row('work-2')} [data-action="account-recheck"]`)
    browser.waitForFunction(`document.querySelector('${row('work-2')} [data-slot="account-status"]')?.textContent === 'Connected'`)
    const probed = await send('GET', '/api/v1/workspace/agent-profiles/work-2/status?refresh=1')
    expect(probed.status).toBe(200)
    expect(JSON.parse(probed.text)).toMatchObject({ status: { status: 'connected', profileId: 'work-2' } })
  })

  it('assigns it as the machine-wide Claude default', async () => {
    const radio = `[data-slot="accounts-defaults"] [data-slot="agents-runner"] [role="radio"][data-value="claude"][data-account="work-2"]`
    browser.waitForFunction(`document.querySelector('${radio}')?.disabled === false`)
    expect(browser.count('[data-slot="agents-account-readonly"]')).toBe(0)
    browser.click(radio)
    await waitForListing((body) => body.defaults.claude === 'work-2', 'the machine default work-2')
    browser.waitForFunction(`document.querySelector('${radio}')?.getAttribute('aria-checked') === 'true'`)
  })

  it('removes it: the row and the default go, the folder stays on disk', async () => {
    browser.click(`${row('work-2')} [data-action="account-remove"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="accounts-remove-confirm"]') !== null`)
    expect(browser.text('[data-slot="accounts-remove-confirm"]')).toContain('Nothing in its folder is deleted')
    browser.click('[data-action="accounts-remove-confirm"]')
    browser.waitForFunction(`document.querySelector('${row('work-2')}') === null`)
    // The confirm dialog fades out after the row goes, and its overlay covers the page until it has
    // unmounted: on a slow machine the next case's click on "Add account" landed on it. Wait it out.
    browser.waitForFunction(`document.querySelector('[data-slot="alert-dialog-overlay"]') === null`)
    const after = await waitForListing((body) => !body.profiles.some((p) => p.id === 'work-2'), 'work-2 gone')
    expect(after.defaults.claude).toBeUndefined()
    expect(existsSync(join(claudeAccounts, 'work-2'))).toBe(true)
  })

  it('re-adds "Work 2" into a NEW folder — the old one, and its login, are never handed out again', () => {
    // Stand-in for the login a real sign-in would have left behind in the removed account's folder.
    writeFileSync(join(claudeAccounts, 'work-2', '.credentials.json'), '{"stale":"login"}', 'utf8')
    addThroughDialog('Work 2', 'work-2-2')
    expect(existsSync(join(claudeAccounts, 'work-2-2'))).toBe(true)
    expect(readdirSync(join(claudeAccounts, 'work-2-2'))).toEqual([])
    expect(readdirSync(join(claudeAccounts, 'work-2'))).toEqual(['.credentials.json'])
    screenshotAccounts('hosted-accounts-manage-readded.png')
  })

  it('refuses a folder change and a local open, and never answers with an fs error', async () => {
    const repoint = await send('PATCH', '/api/v1/workspace/agent-profiles/work-2-2', { configDir: join(dataRoot, 'x') })
    expect(repoint.status).toBe(400)
    expect(JSON.parse(repoint.text)).toEqual({ error: 'configDir is allocated by cezar in hosted mode' })

    const open = await send('POST', '/api/v1/workspace/agent-profiles/work-2-2/open', { file: 'folder' })
    expect(open.status).toBe(409)

    // A directory where the store file goes: the atomic rename fails with a message naming the path.
    const store = join(cezHome, 'agent-accounts.json')
    renameSync(store, `${store}.e2e-saved`)
    mkdirSync(store)
    try {
      const broken = await send('POST', '/api/v1/workspace/agent-profiles', { provider: 'claude', label: 'Broken' })
      expect(broken.status).toBe(500)
      expect(JSON.parse(broken.text)).toEqual({ error: 'could not save the account (see server log)' })
      expect(leaks(broken.text)).toEqual([])
      // The folder allocated for the write that failed is taken back.
      expect(existsSync(join(claudeAccounts, 'broken'))).toBe(false)
    } finally {
      rmSync(store, { recursive: true, force: true })
      renameSync(`${store}.e2e-saved`, store)
    }
    expect((await listing()).profiles.some((p) => p.id === 'work-2-2')).toBe(true)
  })

  // Claude now has two logins (Default and "Work 2"), so the defaults picker and the composer name
  // each one — which is what lets these two cases see the Default login's name.
  it('renames the Claude Default login: its row, the defaults picker and the composer follow, and nothing that chooses it moves', async () => {
    const before = choicesOnDisk()
    const listedBefore = await listing()

    startRenamingClaudeDefault()
    browser.fill(`${claudeDefault} [data-slot="account-rename-input"]`, 'Personal Max')
    browser.click(`${claudeDefault} [data-action="account-rename-save"]`)
    browser.waitForFunction(
      `document.querySelector('${claudeDefault} [data-slot="account-rename-input"]') === null && document.querySelector('${claudeDefault}')?.textContent.includes('Personal Max') === true`,
    )

    const after = await waitForListing(
      (body) => body.profiles.some((p) => p.provider === 'claude' && p.isDefault && p.label === 'Personal Max'),
      'the Claude Default login named Personal Max',
    )
    // Its name moved and nothing else did: the same id, Codex's Default untouched, every choice as it was.
    expect(after.profiles.find((p) => p.provider === 'claude' && p.isDefault)).toMatchObject({ id: 'default' })
    expect(await defaultLabel('codex')).toBe('Default')
    expect({ selections: after.selections, defaults: after.defaults }).toEqual({
      selections: listedBefore.selections,
      defaults: listedBefore.defaults,
    })
    expect(choicesOnDisk()).toEqual(before)

    // The machine-wide defaults picker, on this same page.
    browser.waitForFunction(`document.querySelector('${claudeDefaultPick}')?.textContent.trim() === 'claude · Personal Max'`)
    expect(leaks(html())).toEqual([])
    screenshotAccounts('hosted-accounts-manage-default-renamed.png')

    // The composer: nothing is chosen for this repo, so the pill starts on the Default login — by its new name.
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.disabled === false`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="runner-pill"]')?.textContent.trim() === 'claude · Personal Max'`,
    )
    browser.click('[data-slot="runner-pill"]')
    browser.waitForFunction(`document.querySelector('[data-testid="runner-pill-menu"]') !== null`)
    const options = browser.evaluate(
      `[...document.querySelectorAll('[data-testid="runner-pill-menu"] [role="menuitemradio"]')].map((n) => n.textContent.trim())`,
    ) as string[]
    expect(options).toEqual(expect.arrayContaining(['claude · Personal Max', 'claude · Work 2']))
    expect(options).not.toContain('claude · Default')
    browser.screenshot(`${artifactsDir}/hosted-accounts-manage-default-renamed-composer.png`, { viewport: true })
  }, 90_000)

  it('empties the name back to "Default", and refuses a folder or a removal for a Default login', async () => {
    const before = choicesOnDisk()

    startRenamingClaudeDefault()
    // Emptied the way a person does it: an empty name is how the rename is undone.
    browser.click(`${claudeDefault} [data-slot="account-rename-input"]`)
    browser.press('Control+a')
    browser.press('Backspace')
    browser.click(`${claudeDefault} [data-action="account-rename-save"]`)
    await waitForListing(
      (body) => body.profiles.some((p) => p.provider === 'claude' && p.isDefault && p.label === 'Default'),
      'the Claude Default login named Default again',
    )
    browser.waitForFunction(`document.querySelector('${claudeDefaultPick}')?.textContent.trim() === 'claude · Default'`)
    // Absence, never the built-in name written down.
    const stored = JSON.parse(readFileSync(join(cezHome, 'agent-accounts.json'), 'utf8'))
    expect(stored.defaultLabels ?? {}).not.toHaveProperty('claude')
    expect(choicesOnDisk()).toEqual(before)

    const folder = await send('PATCH', '/api/v1/workspace/agent-profiles/default:claude', { configDir: join(dataRoot, 'x') })
    expect(folder.status).toBe(400)
    expect(JSON.parse(folder.text)).toEqual({
      error: 'the folder of a Default login is the one cezar discovers; only its name can change',
    })
    const removal = await send('DELETE', '/api/v1/workspace/agent-profiles/default:claude')
    expect(removal.status).toBe(404)
    expect(await defaultLabel('claude')).toBe('Default')
    expect(leaks(folder.text + removal.text)).toEqual([])
  }, 90_000)

  it('answers every mutation without a folder — `send` scans each one — and the selection write with only what the listing may name', async () => {
    const added = await send('POST', '/api/v1/workspace/agent-profiles', { provider: 'claude', label: 'Leak check' })
    expect(added.status).toBe(201)
    expect(JSON.parse(added.text).profile).not.toHaveProperty('configDir')
    const id = JSON.parse(added.text).profile.id as string

    // The write answers with the same filtered view the listing serves: its two keys, nothing from the
    // store this version does not know, and no folder.
    const assigned = await send('PUT', '/api/v1/workspace/agent-profiles/selection', { projectId: null, provider: 'claude', profileId: id })
    expect(assigned.status).toBe(200)
    const choices = JSON.parse(assigned.text) as { selections: Record<string, unknown>; defaults: Record<string, unknown> }
    expect(Object.keys(choices).sort()).toEqual(['defaults', 'selections'])
    expect(choices.defaults).toEqual({ claude: id })
    const listed = await listing()
    expect(choices).toEqual({ selections: listed.selections, defaults: listed.defaults })

    // Put back what this case changed: no machine default, and the account gone.
    expect((await send('PUT', '/api/v1/workspace/agent-profiles/selection', { projectId: null, provider: 'claude', profileId: null })).status).toBe(200)
    expect((await send('DELETE', `/api/v1/workspace/agent-profiles/${id}`)).status).toBe(200)
    expect((await listing()).defaults.claude).toBeUndefined()
  })
})

describe.skipIf(PART_B_SKIP !== null)("part B — one project's own account (Linux)", () => {
  it('assigns the project its own account, and the composer starts on it', async () => {
    const created = await send('POST', '/api/v1/workspace/agent-profiles', { provider: 'claude', label: 'Project account' })
    expect(created.status).toBe(201)

    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    const radio = `[data-slot="agents-runner"] [role="radio"][data-value="claude"][data-account="project-account"]`
    browser.waitForFunction(`document.querySelector('${radio}')?.disabled === false`)
    browser.click(radio)
    await waitForListing(
      (body) => Object.values(body.selections).some((selection) => selection.claude === 'project-account'),
      "the boot project's selection project-account",
    )

    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="runner-pill"]')?.textContent.trim() === 'claude · Project account'`,
    )
    browser.screenshot(`${artifactsDir}/hosted-accounts-manage-project.png`)
  })
})
