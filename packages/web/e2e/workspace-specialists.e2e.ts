import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

const repoRoot = resolve(import.meta.dirname, '../../..')
const artifactsDir = resolve(repoRoot, '.ai/qa/artifacts_e2e')
const reportPath = resolve(artifactsDir, 'workspace-specialists.json')
const processRecordPath = resolve(artifactsDir, 'workspace-specialists-processes.json')

type Project = { id: string; root: string; name: string }
type Specialist = { id: string; name: string; builtIn: boolean; instructions: string }
type Run = {
  id: string
  task: string
  projectId?: string
  status?: string
  specialistSnapshot?: { id: string; name: string; instructions: string }
  autonomous?: boolean
  dispatch?: { parentRunId?: string }
  branch?: string
  steps?: Array<{ sessionId?: string; profileId?: string }>
}

let browser: AgentBrowser
let server: ChildProcess
let serverStartedAt = ''
let dataRoot = ''
let secondRoot = ''
let baseUrl = ''
let bootProject = ''
let secondProject = ''
const projectRuns: Array<{ projectId: string; runId: string; status: string }> = []

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

function createGitProject(root: string, name: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  mkdirSync(root, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(root, 'README.md'), `# ${name}\n`, 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')
}

async function requestJson<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(`cezar e2e: ${method} ${url} → ${response.status}: ${payload.error ?? ''}`)
  return payload
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
  throw new Error(`cezar e2e: the specialists server never answered at ${url}`)
}

function isOwnedServerRunning(pid: number, parentPid: number, startedAt: string): boolean {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0)
      return true
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  try {
    const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"; if($p){[PSCustomObject]@{parent=$p.ParentProcessId;command=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    if (!output.trim()) return false
    const row = JSON.parse(output) as {
      parent: number
      command: string
      created: string
    }
    const created = Date.parse(row.created)
    return (
      row.parent === parentPid &&
      row.command.includes(cezarCli) &&
      row.command.toLowerCase().includes('serve') &&
      Number.isFinite(created) &&
      Math.abs(created - Date.parse(startedAt)) < 15_000
    )
  } catch {
    return true
  }
}

function verifyOwnedServer(pid: number, parentPid: number, startedAt: string): boolean {
  return (
    server?.pid === pid &&
    server.exitCode === null &&
    server.spawnfile.includes('node') &&
    isOwnedServerRunning(pid, parentPid, startedAt)
  )
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-specialists-a-'))
  secondRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-specialists-b-'))
  createGitProject(dataRoot, 'specialists project A')
  createGitProject(secondRoot, 'specialists project B')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  serverStartedAt = new Date().toISOString()
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  if (!server.pid) throw new Error('cezar e2e: specialists server did not receive a PID')
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(
    processRecordPath,
    JSON.stringify({
      owner: 'workspace-specialists.e2e.ts',
      purpose: 'isolated server for two-project specialist verification',
      pid: server.pid,
      parentPid: process.pid,
      createdAt: serverStartedAt,
      projectRoots: [dataRoot, secondRoot],
      executable: process.execPath,
      command: [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
      cwd: process.cwd(),
      cleanup: 'afterAll sends SIGTERM to the verified direct child and waits for exit',
      cleanupStatus: 'running',
    }, null, 2) + '\n',
    'utf8',
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  let projects = await getJson<{ projects: Array<Project & { unregistered?: boolean }> }>(`${baseUrl}/api/v1/projects`)
  if (!projects.projects.some((project) => !project.unregistered && resolve(project.root) === resolve(dataRoot))) {
    await requestJson(`${baseUrl}/api/v1/projects`, 'POST', { root: dataRoot })
  }
  const added = await requestJson<{ id?: string; project?: Project }>(`${baseUrl}/api/v1/projects`, 'POST', {
    root: secondRoot,
  })
  projects = await getJson<{ projects: Array<Project & { unregistered?: boolean }> }>(`${baseUrl}/api/v1/projects`)
  secondProject = added.project?.id ?? added.id ?? projects.projects.find((project) => resolve(project.root) === resolve(secondRoot))?.id ?? ''
  if (!secondProject || secondProject === bootProject) throw new Error('cezar e2e: second project was not registered')

  browser = AgentBrowser.open(`e2e-specialists-${process.pid}`)
}, 180_000)

afterAll(async () => {
  browser?.close()
  let cleanupStatus = 'no-process'
  if (server?.pid) {
    const pid = server.pid
    const owned = verifyOwnedServer(pid, process.pid, serverStartedAt)
    if (owned) {
      server.kill('SIGTERM')
      cleanupStatus = 'sigterm-sent'
      await Promise.race([
        new Promise<void>((resolveExit) => server?.once('exit', () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 30_000)),
      ])
      if (server.exitCode !== null) cleanupStatus = `exited:${server.exitCode}`
      else if (!isOwnedServerRunning(pid, process.pid, serverStartedAt)) cleanupStatus = 'exited:signal'
      else cleanupStatus = 'still-running-after-graceful-stop'
    } else {
      cleanupStatus = 'not-terminated-ownership-verification-failed'
    }
  }
  try {
    const previous = JSON.parse(readFileSync(processRecordPath, 'utf8')) as Record<string, unknown>
    writeFileSync(processRecordPath, JSON.stringify({ ...previous, cleanupStatus, stoppedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  } catch {
    /* preserve test failure; the manifest is best-effort */
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    writeFileSync(reportPath, JSON.stringify({ ...report, serverCleanup: cleanupStatus }, null, 2) + '\n', 'utf8')
  } catch {
    /* no report exists when setup or the first scenario fails */
  }
  if (!server?.pid || server.exitCode !== null || !isOwnedServerRunning(server.pid, process.pid, serverStartedAt)) {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
    if (secondRoot) rmSync(secondRoot, { recursive: true, force: true })
  }
})

describe('workspace specialist roles', () => {
  it('keeps roles idle, assigns one role into two isolated project runs, and indexes both', async () => {
    const before = await getJson<{ runs: Run[] }>(`${baseUrl}/api/v1/workspace/runs-index`)
    expect(before.runs).toHaveLength(0)

    const roster = await requestJson<{ specialists: Specialist[] }>(`${baseUrl}/api/v1/workspace/specialists`)
    expect(roster.specialists.map((role) => role.id)).toEqual(expect.arrayContaining(['planner', 'implementer', 'reviewer']))
    const created = await requestJson<{ specialist: Specialist }>(
      `${baseUrl}/api/v1/workspace/specialists`,
      'POST',
      { name: 'Release note writer', description: 'Summarizes a completed change.', instructions: 'Write a concise release note using only this project run.' },
    )
    expect(created.specialist.builtIn).toBe(false)
    let dispatchChild: { projectId: string; runId: string } | undefined

    browser.goto(`${baseUrl}/agents`)
    browser.waitForFunction(`document.querySelector('[data-route="agents"]') !== null`)
    expect(browser.text('h1')).toBe('Agents')
    expect(browser.text('[data-specialist-id="planner"]')).toContain('Planner')
    expect(browser.text(`[data-specialist-id="${created.specialist.id}"]`)).toContain('Release note writer')
    expect(browser.count(`[data-role-assignment="${created.specialist.id}"][href^="/p/${bootProject}/new?"]`)).toBe(1)
    expect(browser.count(`[data-role-assignment="${created.specialist.id}"][href^="/p/${secondProject}/new?"]`)).toBe(1)
    browser.screenshot(`${artifactsDir}/workspace-specialists.png`, { viewport: true })
    expect((await getJson<{ runs: Run[] }>(`${baseUrl}/api/v1/workspace/runs-index`)).runs).toHaveLength(0)

    const assignments = [] as Array<{ projectId: string; runId: string; snapshot: NonNullable<Run['specialistSnapshot']> }>
    for (const projectId of [bootProject, secondProject]) {
      const run = await requestJson<Run>(`${baseUrl}/api/v1/p/${projectId}/runs`, 'POST', {
        workflow: 'quick-task',
        task: `Prepare a release note for ${projectId}.`,
        specialistId: created.specialist.id,
      })
      expect(run.specialistSnapshot).toEqual({
        id: created.specialist.id,
        name: created.specialist.name,
        instructions: created.specialist.instructions,
      })
      expect(run.autonomous).not.toBe(true)
      expect(run.steps?.some((step) => step.sessionId || step.profileId)).toBe(false)
      projectRuns.push({ projectId, runId: run.id, status: run.status ?? 'queued' })
      assignments.push({ projectId, runId: run.id, snapshot: run.specialistSnapshot! })
      if (projectId === bootProject) {
        const child = await requestJson<{ id: string }>(
          `${baseUrl}/api/v1/p/${projectId}/runs/${run.id}/dispatch`,
          'POST',
          { objective: 'Review the release note.', specialistId: created.specialist.id },
        )
        const dispatched = await getJson<Run>(`${baseUrl}/api/v1/p/${projectId}/runs/${child.id}`)
        expect(dispatched.specialistSnapshot).toEqual({
          id: created.specialist.id,
          name: created.specialist.name,
          instructions: created.specialist.instructions,
        })
        expect(dispatched.dispatch?.parentRunId).toBe(run.id)
        dispatchChild = { projectId, runId: child.id }
      }
    }

    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${assignments[0]!.runId}`)
    browser.waitForFunction(`document.querySelector('[data-slot="specialist-role"]') !== null`)
    expect(browser.text('[data-slot="specialist-role"]')).toContain(created.specialist.name)
    expect(browser.count(`[data-slot="specialist-role"] a[href="/p/${bootProject}/agents#specialist-${created.specialist.id}"]`)).toBe(1)

    expect(assignments[0]?.runId).not.toBe(assignments[1]?.runId)
    expect(assignments[0]?.projectId).not.toBe(assignments[1]?.projectId)
    const indexed = await getJson<{ runs: Array<Run & { specialist?: { id: string; name: string } }> }>(
      `${baseUrl}/api/v1/workspace/runs-index`,
    )
    for (const assignment of assignments) {
      expect(indexed.runs).toContainEqual(expect.objectContaining({
        id: assignment.runId,
        projectId: assignment.projectId,
        specialist: { id: created.specialist.id, name: created.specialist.name },
      }))
    }

    writeFileSync(reportPath, JSON.stringify({
      result: 'scenario-passed',
      role: { id: created.specialist.id, name: created.specialist.name },
      projects: [bootProject, secondProject],
      assignments: projectRuns,
      ...(dispatchChild ? { dispatchChild } : {}),
      screenshots: ['workspace-specialists.png'],
      verified: ['idle roster caused no run', 'one role assigned to two project-scoped runs', 'same-project dispatch preserves the selected specialist snapshot and parent link', 'run snapshots and workspace index preserve role identity', 'task thread links back to its specialist', 'assignments carry no account or session identity'],
      reviewGate: { ordinaryHumanReview: true, note: 'Dry-run assignments generated no diff, so the gate itself was not entered.' },
    }, null, 2) + '\n', 'utf8')
  }, 120_000)

  it('rejects a removed specialist id instead of starting an unspecialized run', async () => {
    const removed = await requestJson<{ specialist: Specialist }>(
      `${baseUrl}/api/v1/workspace/specialists`,
      'POST',
      { name: 'Temporary role', description: '', instructions: 'Temporary.' },
    )
    await requestJson(`${baseUrl}/api/v1/workspace/specialists/${removed.specialist.id}`, 'DELETE')
    const response = await fetch(`${baseUrl}/api/v1/p/${bootProject}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'quick-task', task: 'Must not start.', specialistId: removed.specialist.id }),
    })
    expect(response.status).toBe(400)
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    writeFileSync(reportPath, JSON.stringify({ ...report, result: 'passed', rejectedRemovedRole: true }, null, 2) + '\n', 'utf8')
  })
})
