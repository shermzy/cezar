/**
 * Live E2E for `.ai/specs/2026-10-04-cloudflare-workers-ai.md`: a real cezar, a real OpenCode and
 * a real Workers AI model. NOT part of `npm test` or CI — it needs network, a Workers AI token and
 * a built server (`npm run build:server`).
 *
 *   CF_ACCOUNT_ID=<account id> \
 *   CF_WORKERS_AI_TOKEN="$(az keyvault secret show --vault-name t3-secrets --name <secret> --query value -o tsv)" \
 *   node --import tsx .ai/scripts/live-cloudflare-workers-ai.ts [--model <provider/model>] [--only A|B]
 *
 * Scenario A: OpenCode's store holds the key AND the account id; cezar's env has no CLOUDFLARE_*.
 * Scenario B: the store holds the key only; CLOUDFLARE_ACCOUNT_ID is in cezar's env.
 * Writes `.ai/qa/artifacts_cloudflare-workers-ai/` (gitignored). Never prints or writes the token
 * or the account id.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CEZAR_ENTRY = join(REPO_ROOT, 'packages', 'cezar', 'dist', 'index.js');
const REPORT_DIR = join(REPO_ROOT, '.ai', 'qa', 'artifacts_cloudflare-workers-ai');
const IS_WIN = process.platform === 'win32';
const RUN_TIMEOUT_MS = 10 * 60_000;
const TASK = 'Create a file named hello.txt in the repository root containing exactly the text: hi';

type ScenarioName = 'A' | 'B';
const SCENARIOS: Record<ScenarioName, string> = {
  A: 'store holds key + account id; no CLOUDFLARE_* in cezar env (picker fix + store path)',
  B: 'store holds key only; CLOUDFLARE_ACCOUNT_ID in cezar env (account-id forward)',
};

const { values: argv } = parseArgs({
  options: {
    model: { type: 'string', default: 'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code' },
    only: { type: 'string' },
  },
});
const MODEL = argv.model as string;

function die(message: string): never {
  console.error(`live-cloudflare-workers-ai: ${message}`);
  process.exit(2);
}

const TOKEN = process.env.CF_WORKERS_AI_TOKEN?.trim() ?? '';
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID?.trim() ?? '';
// Out of process.env at once, so no child this script spawns (git, the sentinel, powershell,
// taskkill) ever inherits them. They reach OpenCode only through the seeded store / scenario env.
delete process.env.CF_WORKERS_AI_TOKEN;
delete process.env.CF_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT_ID) die('set CF_WORKERS_AI_TOKEN and CF_ACCOUNT_ID (pipe the token from t3-secrets; never paste it)');
if (!existsSync(CEZAR_ENTRY)) die(`no built server at ${CEZAR_ENTRY}; run \`npm run build:server\` first`);
const only = argv.only as ScenarioName | undefined;
if (only !== undefined && !(only in SCENARIOS)) die('--only must be A or B');

/** Every string that leaves this process goes through here. */
function redact(text: string): string {
  return text.split(TOKEN).join('[REDACTED]').split(ACCOUNT_ID).join('[REDACTED]');
}

/**
 * What an interrupt must clean up: the sentinels (ending one makes its cezar flush and exit) and
 * the sandboxes (each holds the token in auth.json). A hard kill of this script cannot run this —
 * run it in the background rather than under a short tool timeout.
 */
const ACTIVE = { sentinels: new Set<ChildProcess>(), sandboxes: new Set<string>() };
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const s of ACTIVE.sentinels) s.kill();
    for (const root of ACTIVE.sandboxes) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch {
        console.error(`live-cloudflare-workers-ai: DELETE ${root} by hand — it contains the token`);
      }
    }
    process.exit(130);
  });
}

/**
 * cezar spawns `CEZ_OPENCODE_BIN ?? 'opencode'` without a shell. On Windows an npm install puts
 * only shims on PATH (`opencode`, `.cmd`, `.ps1`) and a shell-less spawn finds only .exe/.com, so
 * hand cezar the native binary the shims themselves call. POSIX keeps the bare name.
 */
function resolveOpencodeBin(): string {
  if (!IS_WIN) return 'opencode';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !existsSync(join(dir, 'opencode.cmd'))) continue;
    const exe = join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(exe)) return exe;
    die(`found the OpenCode shim in ${dir} but not its target ${exe}`);
  }
  return die('OpenCode is not on PATH (npm i -g opencode-ai)');
}

/** The parent env minus every name that could change what the scenario proves. */
function cleanParentEnv(): NodeJS.ProcessEnv {
  const dropped = ['CEZ_ENV_PASSTHROUGH', 'CEZ_AGENT_ENV_FULL', 'CEZ_DRY_RUN', 'CEZ_HOME', 'CEZ_OPENCODE_BIN', 'CEZ_SUPERVISOR_PID'];
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    // OPENCODE_* (OPENCODE_DB, OPENCODE_CONFIG…) would point OpenCode outside the sandbox.
    if (['CLOUDFLARE_', 'CF_', 'XDG_', 'OPENCODE_'].some((p) => upper.startsWith(p)) || dropped.includes(upper)) continue;
    env[name] = value;
  }
  return env;
}

interface Sandbox { root: string; data: string; config: string; cache: string; state: string; cezHome: string; project: string }

/** Temp homes for OpenCode and cezar, plus a throwaway one-commit repo that cezar serves. */
function makeSandbox(name: ScenarioName): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `cez-cf-${name}-`));
  const box: Sandbox = {
    root,
    data: join(root, 'data'),
    config: join(root, 'config'),
    cache: join(root, 'cache'),
    state: join(root, 'state'),
    cezHome: join(root, 'cez-home'),
    project: join(root, 'project'),
  };
  for (const dir of [box.data, box.config, box.cache, box.state, box.cezHome, box.project]) mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: box.project, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'cezar-live-e2e');
  git('config', 'user.email', 'e2e@localhost');
  writeFileSync(join(box.project, 'README.md'), '# Workers AI live check\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  return box;
}

function sandboxEnv(box: Sandbox, opencodeBin: string): NodeJS.ProcessEnv {
  return {
    ...cleanParentEnv(),
    XDG_DATA_HOME: box.data,
    XDG_CONFIG_HOME: box.config,
    XDG_CACHE_HOME: box.cache,
    XDG_STATE_HOME: box.state,
    CEZ_HOME: box.cezHome,
    CEZ_OPENCODE_BIN: opencodeBin,
    // A changed non-autonomous run parks at `review` only with the gate on (off by default →
    // it would settle `done`). Same switch packages/web/e2e/review-gate.e2e.ts uses.
    CEZ_REVIEW_GATE: '1',
    // Auto-naming runs the DEFAULT runner (claude) against the user's real account; keep it off.
    CEZ_AUTONAME: '0',
    CEZ_NO_BANNER: '1',
    CEZ_SKILLS_AUTO_UPDATE: '0',
    CEZ_AUTOMATIONS: '0',
  };
}

/**
 * Write the credential the way OpenCode 1.18.1's `/connect` does. A: the login asked for the
 * account id and stored it. B: the login shell already had CLOUDFLARE_ACCOUNT_ID, so it never asked.
 */
function seedStore(box: Sandbox, name: ScenarioName): void {
  const credential: Record<string, unknown> = { type: 'api', key: TOKEN };
  if (name === 'A') credential.metadata = { accountId: ACCOUNT_ID };
  const dir = join(box.data, 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'cloudflare-workers-ai': credential }, null, 2), { mode: 0o600 });
}

function verifyStore(opencodeBin: string, env: NodeJS.ProcessEnv): void {
  const out = execFileSync(opencodeBin, ['auth', 'list'], { env, encoding: 'utf8', timeout: 30_000 }).replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
  if (!/cloudflare[ -]workers[ -]ai/i.test(out)) throw new Error(`opencode auth list does not show the seeded credential:\n${redact(out)}`);
  // Warm the sandbox's models.dev cache: cezar's discovery gives `opencode models` only 10 s, and a
  // cold cache fetches the catalog first. This fills a cache; it proves nothing either way.
  try {
    execFileSync(opencodeBin, ['models'], { env, stdio: 'ignore', timeout: 90_000 });
  } catch {
    // A failed warm-up is not a verdict; cezar's own discovery is what the scenario asserts on.
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

// ---- process ownership ---------------------------------------------------------------------

interface Proc { pid: number; ppid: number; name: string; startedMs: number }

function processTable(): Proc[] {
  if (IS_WIN) {
    const script =
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; ' +
      'name = $_.Name; started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { "" }) } } | ConvertTo-Json -Compress';
    const rows = JSON.parse(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 << 20 }),
    ) as Array<{ pid: number; ppid: number; name: string; started: string }>;
    return rows.map((r) => ({ pid: r.pid, ppid: r.ppid, name: r.name, startedMs: r.started ? Date.parse(r.started) : 0 }));
  }
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 8)
    .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), startedMs: Date.parse(f.slice(2, 7).join(' ')), name: f.slice(7).join(' ') }));
}

/** `rootPid` and everything below it. A "child" older than its parent is a recycled PID, not ours. */
function tree(rootPid: number, table = processTable()): Proc[] {
  const root = table.find((p) => p.pid === rootPid);
  if (!root) return [];
  const out: Proc[] = [root];
  for (let i = 0; i < out.length; i++) {
    const parent = out[i] as Proc;
    for (const p of table) {
      if (p.ppid === parent.pid && p.pid !== parent.pid && p.startedMs >= parent.startedMs && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * What may be force-stopped, and what may only be reported.
 *
 * `verified`: a recorded process still alive with the SAME creation time, or a live descendant of
 * one (walked down from a live, verified parent). Nothing else is ever killed.
 * `unverified`: a live process whose parent PID is a recorded process that has since exited. It is
 * probably ours, but Windows recycles PIDs fast, so it is reported, never killed.
 */
function leftovers(owned: Map<number, Proc>): { verified: Proc[]; unverified: Proc[] } {
  const table = processTable();
  const verified = new Map<number, Proc>();
  for (const p of table) {
    if (owned.get(p.pid)?.startedMs !== p.startedMs) continue;
    for (const d of tree(p.pid, table)) verified.set(d.pid, d);
  }
  const unverified = table.filter((p) => {
    if (verified.has(p.pid)) return false;
    const parent = owned.get(p.ppid);
    return parent !== undefined && !verified.has(p.ppid) && p.startedMs >= parent.startedMs;
  });
  return { verified: [...verified.values()], unverified };
}

function stillAlive(p: Proc): boolean {
  return processTable().some((q) => q.pid === p.pid && q.startedMs === p.startedMs);
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(1_000);
  }
  return check();
}

// ---- cezar API -----------------------------------------------------------------------------

async function api<T>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a text route (the diff)
  }
  return { status: res.status, body: body as T };
}

function waitForCockpit(child: ChildProcess, log: string[]): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('cezar did not print its cockpit URL within 90s')), 90_000);
    const check = () => {
      const match = log.join('').match(/cockpit → (http:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      child.stdout?.off('data', check);
      resolveUrl((match[1] as string).replace(/\/$/, ''));
    };
    child.stdout?.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cezar exited during boot (${code})`));
    });
  });
}

interface RunView { id: string; status: string; activity?: string; error?: string; diffStat?: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number }

const SETTLED = ['review', 'done', 'failed', 'cancelled'];

/** `onStatus` sees every polled status, so teardown knows whether a `finish` is still needed. */
async function waitForReview(base: string, runId: string, onPoll: (status: string) => void): Promise<RunView> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let finishSent = false;
  while (Date.now() < deadline) {
    const { body: run } = await api<RunView>(base, `/runs/${runId}`);
    onPoll(run.status);
    if (SETTLED.includes(run.status)) return run;
    // A non-autonomous run parks at `waiting` (or reports `running` + `monitoring`) once the agent
    // ends its turn; finishing it sends it to the review gate and makes cezar end OpenCode.
    // Never `finish` a run already at `review`: that would move it on to `done`.
    if (!finishSent && (run.status === 'waiting' || (run.status === 'running' && run.activity === 'monitoring'))) {
      const fin = await api(base, `/runs/${runId}/finish`, { method: 'POST' });
      finishSent = fin.status === 200 || fin.status === 409;
    }
    await sleep(5_000);
  }
  throw new Error(`run ${runId} did not reach review within ${RUN_TIMEOUT_MS / 60_000} min`);
}

// ---- one scenario --------------------------------------------------------------------------

interface ScenarioResult {
  scenario: ScenarioName;
  description: string;
  ok: boolean;
  failure?: string;
  opencodeBin: string;
  opencodeVersion: string;
  model: string;
  discovery?: { source: string; workersAiModels: number; modelListed: boolean; reason?: string };
  run?: { id: string; finalStatus: string; diffTouchesHelloTxt: boolean; diffStat?: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number };
  teardown: { finishStatus?: number; opencodeGoneGracefully?: boolean; cezarExitedGracefully?: boolean; forceKilled: string[]; unresolved: string[]; unverified: string[]; sandboxRemoved?: boolean };
  startedAt: string;
  finishedAt?: string;
}

async function runScenario(name: ScenarioName, opencodeBin: string, opencodeVersion: string): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    scenario: name,
    description: SCENARIOS[name],
    ok: false,
    opencodeBin,
    opencodeVersion,
    model: MODEL,
    teardown: { forceKilled: [], unresolved: [], unverified: [] },
    startedAt: new Date().toISOString(),
  };
  const box = makeSandbox(name);
  ACTIVE.sandboxes.add(box.root);
  let lastStatus = '';
  const owned = new Map<number, Proc>();
  const record = (pid: number) => {
    for (const p of tree(pid)) if (!owned.has(p.pid)) owned.set(p.pid, p);
  };
  const log: string[] = [];
  let sentinel: ChildProcess | undefined;
  let cezar: ChildProcess | undefined;
  let base = '';
  let runId: string | undefined;

  try {
    seedStore(box, name);
    const env = sandboxEnv(box, opencodeBin);
    verifyStore(opencodeBin, env);
    if (name === 'B') env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;

    // cezar follows CEZ_SUPERVISOR_PID down: ending this sentinel is its graceful stop.
    sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    ACTIVE.sentinels.add(sentinel);
    const port = await freePort();
    cezar = spawn(process.execPath, [CEZAR_ENTRY, 'serve', '--no-open', '--port', String(port)], {
      cwd: box.project,
      env: { ...env, CEZ_SUPERVISOR_PID: String(sentinel.pid) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cezar.stdout?.setEncoding('utf8').on('data', (chunk: string) => log.push(chunk));
    cezar.stderr?.setEncoding('utf8').on('data', (chunk: string) => log.push(chunk));
    base = await waitForCockpit(cezar, log);
    record(cezar.pid as number);

    // Discovery: a fresh boot per scenario, so the catalog answers live, never from cache.
    const models = await api<{ source: string; models?: Array<{ id: string }>; reason?: string }>(base, '/models?runner=opencode');
    const workersAi = (models.body.models ?? []).filter((m) => m.id.startsWith('cloudflare-workers-ai/@'));
    result.discovery = {
      source: models.body.source,
      workersAiModels: workersAi.length,
      modelListed: workersAi.some((m) => m.id === MODEL),
      ...(models.body.reason ? { reason: redact(models.body.reason) } : {}),
    };
    if (models.body.source !== 'live') throw new Error(`model discovery answered "${models.body.source}"${models.body.reason ? `: ${redact(models.body.reason)}` : ''}`);
    if (workersAi.length === 0) throw new Error('model discovery listed no cloudflare-workers-ai/@… model');
    if (!result.discovery.modelListed) throw new Error(`${MODEL} is not among the discovered Workers AI models; pass another with --model (never substituted)`);

    const created = await api<{ id?: string; error?: string }>(base, '/runs', {
      method: 'POST',
      body: { workflow: 'quick-task', task: TASK, runner: 'opencode', model: MODEL, generateFollowups: false },
    });
    if (created.status !== 201 || !created.body.id) throw new Error(`POST /runs answered ${created.status}: ${redact(JSON.stringify(created.body))}`);
    runId = created.body.id;
    const run = await waitForReview(base, runId, (status) => {
      lastStatus = status;
      record(cezar?.pid as number);
    });
    const diff = await api<string>(base, `/runs/${runId}/diff`);
    result.run = {
      id: runId,
      finalStatus: run.status,
      diffTouchesHelloTxt: typeof diff.body === 'string' && diff.body.includes('hello.txt'),
      diffStat: run.diffStat,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
    };
    if (run.status !== 'review') throw new Error(`run ended "${run.status}"${run.error ? `: ${redact(run.error)}` : ''}`);
    if (!result.run.diffTouchesHelloTxt) throw new Error('the run reached review but its diff does not touch hello.txt');
    result.ok = true;
  } catch (error) {
    result.failure = redact(error instanceof Error ? error.message : String(error));
  } finally {
    const fail = (message: string) => {
      result.ok = false;
      result.failure = `${result.failure ? `${result.failure}; ` : ''}${message}`;
    };
    // 1. End the agent session through cezar's own runner teardown — only if it is still open.
    //    `finish` on a run already at `review` would move it on to `done`.
    if (base && runId && (lastStatus === 'waiting' || lastStatus === 'running' || lastStatus === 'queued')) {
      const fin = await api(base, `/runs/${runId}/finish`, { method: 'POST' }).catch(() => undefined);
      result.teardown.finishStatus = fin?.status;
    }
    // 2. Wait for cezar's OpenCode children to go.
    if (cezar?.pid !== undefined) {
      const cezarPid = cezar.pid;
      record(cezarPid);
      result.teardown.opencodeGoneGracefully = await until(() => !tree(cezarPid).some((p) => /^opencode/i.test(p.name)), 30_000);
    }
    // 3. Graceful cezar stop: its supervisor watch sees the sentinel gone and exits.
    sentinel?.kill();
    if (sentinel) ACTIVE.sentinels.delete(sentinel);
    if (cezar) result.teardown.cezarExitedGracefully = await exited(cezar, 30_000);
    // 4. Last resort: force-stop only processes verified as ours (PID + creation time, or a live
    //    descendant of one). Anything merely probable is reported, never killed.
    const { verified, unverified } = leftovers(owned);
    result.teardown.unverified = unverified.map((p) => `${p.name}#${p.pid}`);
    for (const p of verified) {
      if (!stillAlive(p)) continue; // e.g. Windows took it down with its killed parent
      try {
        if (IS_WIN) execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { stdio: 'ignore' });
        else process.kill(p.pid, 'SIGKILL');
        result.teardown.forceKilled.push(`${p.name}#${p.pid}`);
      } catch {
        if (stillAlive(p)) result.teardown.unresolved.push(`${p.name}#${p.pid}`);
      }
    }
    if (result.teardown.unresolved.length > 0) fail(`could not stop ${result.teardown.unresolved.join(', ')}`);
    writeFileSync(join(REPORT_DIR, `${name}-cezar.log`), redact(log.join('')));
    // The sandbox holds the token in auth.json: failing to remove it is a failure, with its path.
    try {
      rmSync(box.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      result.teardown.sandboxRemoved = true;
      ACTIVE.sandboxes.delete(box.root);
    } catch {
      result.teardown.sandboxRemoved = false;
      fail(`sandbox not removed (it contains the token): ${box.root}`);
      console.error(`live-cloudflare-workers-ai: DELETE ${box.root} by hand — it contains the token`);
    }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

function markdown(report: { generatedAt: string; platform: string; node: string; model: string; passed: boolean; scenarios: ScenarioResult[] }): string {
  const lines = [
    '# Cloudflare Workers AI through OpenCode — live E2E',
    '',
    `Spec: \`.ai/specs/2026-10-04-cloudflare-workers-ai.md\` · generated ${report.generatedAt} · ${report.platform} · Node ${report.node}`,
    '',
    `**Result: ${report.passed ? 'PASS' : 'FAIL'}** · model \`${report.model}\``,
    '',
    '| Scenario | Result | Discovery | Workers AI models | Run | Final status | Diff touches hello.txt | Tokens in/out | Teardown |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of report.scenarios) {
    const t = s.teardown;
    const teardown = `finish ${t.finishStatus ?? '–'}, opencode gone ${t.opencodeGoneGracefully ?? '–'}, cezar exited ${t.cezarExitedGracefully ?? '–'}, force-killed ${t.forceKilled.length}, unresolved ${t.unresolved.length}, unverified (reported only) ${t.unverified.length}, sandbox removed ${t.sandboxRemoved ?? '–'}`;
    lines.push(
      `| ${s.scenario} — ${s.description} | ${s.ok ? 'PASS' : `FAIL: ${s.failure ?? ''}`} | ${s.discovery?.source ?? '–'} | ${s.discovery?.workersAiModels ?? '–'} | ${s.run?.id ?? '–'} | ${s.run?.finalStatus ?? '–'} | ${s.run?.diffTouchesHelloTxt ?? '–'} | ${s.run?.inputTokens ?? '–'}/${s.run?.outputTokens ?? '–'} | ${teardown} |`,
    );
  }
  const first = report.scenarios[0];
  if (first) lines.push('', `OpenCode: \`${first.opencodeBin}\` (${first.opencodeVersion})`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const opencodeBin = resolveOpencodeBin();
  const opencodeVersion = execFileSync(opencodeBin, ['--version'], { env: cleanParentEnv(), encoding: 'utf8' }).trim();
  const results: ScenarioResult[] = [];
  for (const name of only ? [only] : (['A', 'B'] as ScenarioName[])) {
    console.log(`scenario ${name}: ${SCENARIOS[name]}`);
    const result = await runScenario(name, opencodeBin, opencodeVersion);
    console.log(`scenario ${name}: ${result.ok ? 'PASS' : `FAIL — ${result.failure ?? ''}`}`);
    results.push(result);
  }
  const report = {
    spec: '.ai/specs/2026-10-04-cloudflare-workers-ai.md',
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    model: MODEL,
    passed: results.length > 0 && results.every((r) => r.ok),
    scenarios: results,
  };
  writeFileSync(join(REPORT_DIR, 'report.json'), `${redact(JSON.stringify(report, null, 2))}\n`);
  writeFileSync(join(REPORT_DIR, 'report.md'), redact(markdown(report)));
  console.log(`${report.passed ? 'PASS' : 'FAIL'} — report: ${join(REPORT_DIR, 'report.md')}`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exitCode = 1;
});
