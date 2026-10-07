import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface ProcessIdentity {
  pid: number
  ppid: number
  created: string
  command: string
  cwd: string
}

interface ProcessRecord extends ProcessIdentity {
  firstSeen: string
  lastSeen: string
  parents: number[]
}

interface OwnedServerOptions {
  task: string
  purpose: string
  artifactPath: string
  baseUrl: string
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting'])

function allProcesses(knownPids: ReadonlySet<number> = new Set()): ProcessIdentity[] {
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
    const parsed = JSON.parse(json) as
      | Array<{ pid: number; ppid: number; created: string; command: string }>
      | { pid: number; ppid: number; created: string; command: string }
      | null
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return rows.flatMap((row) => {
      const pid = Number(row.pid)
      if (!row.created) {
        if (knownPids.has(pid)) throw new Error(`process ${pid} is visible but its creation identity is unavailable`)
        return []
      }
      return [{ pid, ppid: Number(row.ppid), created: row.created, command: row.command, cwd: '<unavailable>' }]
    })
  }
  if (process.platform === 'darwin') {
    const output = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const found = new Set<number>()
    const processes = output.split('\n').flatMap((line) => {
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
      if (Number.isFinite(pid)) found.add(pid)
      const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
      if (!match) {
        if (Number.isFinite(pid) && knownPids.has(pid)) throw new Error(`process ${pid} is visible but its identity could not be read`)
        return []
      }
      const rawPid = match[1]!
      const rawPpid = match[2]!
      const created = match[3]!
      const command = match[4]!
      if (!command && knownPids.has(Number(rawPid))) throw new Error(`process ${rawPid} is visible but its command is unavailable`)
      return [{ pid: Number(rawPid), ppid: Number(rawPpid), created, command, cwd: '<unavailable>' }]
    })
    for (const pid of knownPids) {
      if (found.has(pid) && !processes.some((entry) => entry.pid === pid)) {
        throw new Error(`process ${pid} is visible but its identity could not be read`)
      }
    }
    return processes
  }
  if (process.platform !== 'linux') throw new Error(`owned E2E process verification is unsupported on ${process.platform}`)

  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  return readdirSync('/proc', { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return []
    const pid = Number(entry.name)
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      if (knownPids.has(pid)) throw new Error(`process ${pid} identity is unreadable: ${String(error)}`)
      return []
    }
    const close = stat.lastIndexOf(') ')
    const fields = stat.slice(close + 2).split(' ')
    const ppid = Number(fields[1])
    const startTicks = fields[19]
    if (!Number.isFinite(ppid) || !startTicks) {
      if (knownPids.has(pid)) throw new Error(`process ${pid} stat did not contain an identity`)
      return []
    }
    let command: string
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() || stat.slice(stat.indexOf('(') + 1, close)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      if (knownPids.has(pid)) throw new Error(`process ${pid} command is unreadable: ${String(error)}`)
      return []
    }
    let cwd = ''
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      cwd = '<unavailable>'
    }
    return [{ pid, ppid, created: `${bootId}:${startTicks}`, command, cwd }]
  })
}

function processTree(rootPid: number, processes: ProcessIdentity[]): ProcessIdentity[] {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
  if (!byPid.has(rootPid)) return []
  const pids = new Set([rootPid])
  for (let pass = 0; pass < processes.length; pass += 1) {
    let changed = false
    for (const entry of processes) {
      if (pids.has(entry.pid) || !pids.has(entry.ppid)) continue
      pids.add(entry.pid)
      changed = true
    }
    if (!changed) break
  }
  return [...pids].flatMap((pid) => {
    const entry = byPid.get(pid)
    return entry ? [entry] : []
  })
}

function sameRoot(current: ProcessIdentity | undefined, original: ProcessIdentity | undefined): boolean {
  return !!current && !!original && current.created === original.created && current.command === original.command && current.ppid === original.ppid
}

function waitForExit(server: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs)
    server.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

function activeRuns(body: unknown): Array<{ id: string; projectId?: string }> {
  const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? (body as { runs?: unknown }).runs : undefined
  if (!Array.isArray(rows)) throw new Error('E2E cleanup: run list had an unexpected shape')
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const run = row as { id?: unknown; projectId?: unknown; status?: unknown }
    if (typeof run.id !== 'string' || typeof run.status !== 'string' || !ACTIVE_RUN_STATUSES.has(run.status)) return []
    return [{ id: run.id, ...(typeof run.projectId === 'string' ? { projectId: run.projectId } : {}) }]
  })
}

async function cancelFixtureRuns(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000
  const request = async (path: string, init?: RequestInit, allowRace = false): Promise<unknown | undefined> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('E2E cleanup: timed out cancelling fixture runs')
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(Math.min(5_000, remaining)),
    })
    if (allowRace && (response.status === 404 || response.status === 409)) return undefined
    if (!response.ok) throw new Error(`E2E cleanup: ${path} returned ${response.status}`)
    return response.json() as Promise<unknown>
  }

  while (true) {
    // `/runs` covers the boot repo even when Windows cannot register its root in the workspace
    // index. The workspace index adds registered projects; duplicate IDs collapse below.
    const found = [
      ...activeRuns(await request('/api/v1/runs')),
      ...activeRuns(await request('/api/v1/workspace/runs-index')),
    ]
    const byId = new Map<string, { id: string; projectId?: string }>()
    for (const run of found) {
      const previous = byId.get(run.id)
      if (!previous || run.projectId) byId.set(run.id, run)
    }
    const runs = [...byId.values()]
    if (runs.length === 0) return
    for (const run of runs) {
      const route = run.projectId
        ? `/api/v1/p/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.id)}/cancel`
        : `/api/v1/runs/${encodeURIComponent(run.id)}/cancel`
      await request(route, { method: 'POST' }, true)
    }
    await new Promise((done) => setTimeout(done, 200))
  }
}

export function monitorOwnedServer(server: ChildProcess, options: OwnedServerOptions): {
  capture(): Promise<void>
  stopAndVerify(): Promise<void>
} {
  const records = new Map<string, ProcessRecord>()
  const errors = new Set<string>()
  const argv = [server.spawnfile, ...server.spawnargs].join(' ')
  let snapshots = 0
  let parentIdentity: ProcessIdentity | undefined
  let rootIdentity: ProcessIdentity | undefined
  let captureQueue = Promise.resolve()
  const launchedAt = new Date().toISOString()

  const save = () => {
    try {
      mkdirSync(dirname(options.artifactPath), { recursive: true })
      writeFileSync(
        options.artifactPath,
        `${JSON.stringify(
          {
            task: options.task,
            purpose: options.purpose,
            pid: server.pid ?? null,
            parentPid: process.pid,
            parentIdentity,
            command: argv,
            launchedAt,
            workingDirectory: process.cwd(),
            cleanupOwner: 'this E2E suite afterAll hook',
            artifactPath: options.artifactPath,
            capturedAt: new Date().toISOString(),
            snapshots,
            errors: [...errors],
            processes: [...records.values()],
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch (error) {
      errors.add(`process artifact could not be written: ${String(error)}`)
    }
  }

  const capture = () => {
    captureQueue = captureQueue.then(() => {
      try {
        if (server.pid === undefined) throw new Error('spawned server has no PID')
        const seenAt = new Date().toISOString()
        const knownPids = new Set([...records.values()].map((entry) => entry.pid))
        knownPids.add(server.pid)
        const processes = allProcesses(knownPids)
        const parent = processes.find((entry) => entry.pid === process.pid)
        parentIdentity = parent ? { ...parent, cwd: parent.cwd === '<unavailable>' ? process.cwd() : parent.cwd } : undefined
        if (!parentIdentity) errors.add('test runner process identity could not be verified')
        const root = processes.find((entry) => entry.pid === server.pid)
        if (root) {
          if (!rootIdentity) {
            if (root.ppid !== process.pid) errors.add(`spawned server ${root.pid} has unexpected parent ${root.ppid}`)
            else rootIdentity = root
          } else if (!sameRoot(root, rootIdentity)) {
            errors.add(`spawned server PID ${root.pid} now has a different process identity`)
          }
        }
        const tree = sameRoot(root, rootIdentity) ? processTree(server.pid, processes) : []
        snapshots += 1
        for (const entry of tree) {
          const key = `${entry.pid}:${entry.created}`
          const current = records.get(key)
          const known = process.platform === 'win32' && entry.pid === server.pid ? { ...entry, cwd: process.cwd() } : entry
          if (current) {
            current.lastSeen = seenAt
            if (!current.parents.includes(known.ppid)) current.parents.push(known.ppid)
          } else {
            records.set(key, { ...known, firstSeen: seenAt, lastSeen: seenAt, parents: [known.ppid] })
          }
        }
      } catch (error) {
        errors.add(String(error))
      }
      save()
    })
    return captureQueue
  }

  save()
  const timer = setInterval(() => void capture(), 500)
  timer.unref()
  void capture()

  return {
    capture,
    async stopAndVerify() {
      let failure: unknown
      try {
        await capture()
        const rootWasSeen = !!rootIdentity && [...records.values()].some((entry) => entry.pid === server.pid && entry.created === rootIdentity?.created)
        if (!rootWasSeen) throw new Error('E2E cleanup: could not verify the spawned server process identity')

        if (server.exitCode === null && server.signalCode === null) {
          await cancelFixtureRuns(options.baseUrl)
          await capture()
          const currentRoot = allProcesses(new Set([server.pid!])).find((entry) => entry.pid === server.pid)
          if (!sameRoot(currentRoot, rootIdentity)) throw new Error('E2E cleanup: spawned server identity changed before shutdown')
          if (!server.connected) throw new Error('E2E cleanup: server IPC channel is unavailable')
          await new Promise<void>((done, fail) => {
            server.send({ type: 'cezar-e2e-shutdown' }, (error) => (error ? fail(error) : done()))
          })
          if (!(await waitForExit(server, 15_000))) {
            throw new Error('E2E cleanup: server did not exit after its graceful IPC shutdown')
          }
        }

        await capture()
        if (errors.size) throw new Error(`E2E cleanup: process census failed: ${[...errors].join('; ')}`)
        const identities = [...records.values()]
        const deadline = Date.now() + 10_000
        let survivors = identities
        while (Date.now() < deadline) {
          const live = new Map(allProcesses(new Set(identities.map((entry) => entry.pid))).map((entry) => [`${entry.pid}:${entry.created}`, entry]))
          survivors = identities.filter((entry) => live.has(`${entry.pid}:${entry.created}`))
          if (survivors.length === 0) break
          await new Promise((done) => setTimeout(done, 200))
        }
        if (survivors.length) {
          throw new Error(`E2E cleanup: owned processes remain alive: ${survivors.map((entry) => `${entry.pid} ${entry.command}`).join('; ')}`)
        }
      } catch (error) {
        errors.add(String(error))
        failure = error
      } finally {
        clearInterval(timer)
        await captureQueue
        save()
      }
      if (failure) throw failure
    },
  }
}
