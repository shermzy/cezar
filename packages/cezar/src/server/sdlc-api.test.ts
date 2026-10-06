import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sdlcAuditSchema, sdlcBaselineApplySchema, sdlcBaselinePlanSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { startAdoption } from '../sdlc/adopt.ts';
import { SdlcReader } from '../sdlc/reader.ts';
import { sdlcRoutes, type AdoptResult } from './sdlc.ts';

/**
 * The routes are exercised without the project registry on purpose: the registry's schema only
 * accepts POSIX-absolute roots, so a registry-backed fixture cannot exist on a Windows developer
 * machine. The reader takes its projects by injection, and the routes mount the real validators
 * and handlers, so everything specific to this feature is still the real code.
 */
const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.flush();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-sdlc-api-'));
  dirs.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function setup(opts: { localHandoff?: boolean; adopt?: (id: string) => Promise<AdoptResult> } = {}) {
  const bootRoot = repo({ 'CLAUDE.md': 'Verify: npm test' });
  const bare = repo();
  const projects = [
    { id: 'boot', root: bootRoot, name: 'Boot' },
    { id: 'bare', root: bare },
  ];
  const reader = new SdlcReader({ projects: async () => projects });
  const adopt = vi.fn(opts.adopt ?? (async (id: string) => ({ runId: `run-${id}` })));
  const app = new Hono().route('/api/v1', sdlcRoutes({ reader, adopt, localHandoff: () => opts.localHandoff ?? true }));
  const post = (path: string, body: unknown) =>
    app.request(`/api/v1/workspace/sdlc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, post, adopt, bootRoot, bare, projects };
}

describe('GET /workspace/sdlc/audit', () => {
  it('scores every project, matches the contract, and writes nothing', async () => {
    const { app, bare } = setup();
    const before = readdirSync(bare);
    const res = await app.request('/api/v1/workspace/sdlc/audit');
    expect(res.status).toBe(200);
    const data = sdlcAuditSchema.parse(await res.json());
    const byId = new Map(data.projects.map((p) => [p.projectId, p]));
    expect(byId.get('boot')?.name).toBe('Boot');
    expect(byId.get('boot')?.results.find((r) => r.play === 'claude-md')?.score).toBe('present');
    expect(byId.get('bare')?.results.every((r) => r.score === 'absent')).toBe(true);
    expect(byId.get('bare')?.next).toBe('claude-md');
    expect(data.plays.length).toBeGreaterThan(5);
    expect(readdirSync(bare)).toEqual(before);
  });

  it('reports a project whose folder disappeared as missing instead of failing the audit', async () => {
    const { app, bare } = setup();
    rmSync(bare, { recursive: true, force: true });
    const res = await app.request('/api/v1/workspace/sdlc/audit');
    expect(res.status).toBe(200);
    const data = sdlcAuditSchema.parse(await res.json());
    expect(data.projects.find((p) => p.projectId === 'bare')).toMatchObject({ status: 'missing', results: [] });
    expect(data.projects.find((p) => p.projectId === 'boot')?.status).toBe('ok');
  });
});

describe('POST /workspace/sdlc/baseline/plan', () => {
  it('shows what adoption would create and writes nothing', async () => {
    const { post, bare } = setup();
    const before = readdirSync(bare).sort();
    const res = await post('baseline/plan', { projectIds: ['bare'] });
    expect(res.status).toBe(200);
    const plan = sdlcBaselinePlanSchema.parse(await res.json());
    expect(plan.projects[0]?.files.every((f) => f.action === 'create')).toBe(true);
    expect(plan.projects[0]?.files.map((f) => f.path)).toContain('CLAUDE.md');
    expect(readdirSync(bare).sort()).toEqual(before);
  });

  it('plans skip-diverged for a CLAUDE.md the repo already wrote', async () => {
    const { post } = setup();
    const res = await post('baseline/plan', { projectIds: ['boot'] });
    const plan = sdlcBaselinePlanSchema.parse(await res.json());
    expect(plan.projects[0]?.files.find((f) => f.path === 'CLAUDE.md')?.action).toBe('skip-diverged');
  });

  it('answers 404 for an unknown project', async () => {
    expect((await setup().post('baseline/plan', { projectIds: ['nope'] })).status).toBe(404);
  });

  it.each([
    ['no ids', { projectIds: [] }],
    ['more than fifty ids', { projectIds: Array.from({ length: 51 }, (_, i) => `p${i}`) }],
    ['a wrong shape', { projects: ['x'] }],
  ])('rejects %s with 400 and the usual { error } body', async (_label, body) => {
    const res = await setup().post('baseline/plan', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('POST /workspace/sdlc/baseline/apply', () => {
  it('starts one task per project and returns the run ids', async () => {
    const { post, adopt } = setup();
    const res = await post('baseline/apply', { projectIds: ['boot', 'bare', 'boot'] });
    expect(res.status).toBe(201);
    expect(sdlcBaselineApplySchema.parse(await res.json())).toEqual({
      runs: [
        { projectId: 'boot', runId: 'run-boot' },
        { projectId: 'bare', runId: 'run-bare' },
      ],
    });
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  it('writes nothing into a repository itself', async () => {
    const { post, bare } = setup();
    const before = readdirSync(bare).sort();
    await post('baseline/apply', { projectIds: ['bare'] });
    expect(readdirSync(bare).sort()).toEqual(before);
  });

  it('answers 404 for an unknown project and starts nothing for the known ones in the same request', async () => {
    const { post, adopt } = setup();
    expect((await post('baseline/apply', { projectIds: ['boot', 'nope'] })).status).toBe(404);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('is refused on a hosted cockpit, which has no local checkouts to write', async () => {
    const { post, adopt } = setup({ localHandoff: false });
    expect((await post('baseline/apply', { projectIds: ['boot'] })).status).toBe(409);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('reports a project that fails to start as an error row without failing the others', async () => {
    const { post } = setup({ adopt: async (id) => (id === 'bare' ? { error: 'worktree unavailable' } : { runId: 'run-1' }) });
    const res = await post('baseline/apply', { projectIds: ['boot', 'bare'] });
    expect(res.status).toBe(201);
    expect(sdlcBaselineApplySchema.parse(await res.json()).runs).toEqual([
      { projectId: 'boot', runId: 'run-1' },
      { projectId: 'bare', error: 'worktree unavailable' },
    ]);
  });
});

describe('startAdoption', () => {
  function target() {
    const root = mkdtempSync(join(tmpdir(), 'cez-sdlc-adopt-'));
    dirs.push(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const startRun = vi.fn(() => ({ id: 'started' }));
    return { store, startRun, manager: { startRun } as unknown as RunManager };
  }
  const run = (store: RunStore, workflow: string) =>
    store.createRun({ title: 't', workflow, task: 'x', steps: [{ id: 'apply', name: 'apply', kind: 'check' }] });

  it('starts the built-in sdlc-baseline workflow, which is one check step and no agent', () => {
    const t = target();
    expect(startAdoption(t)).toEqual({ runId: 'started' });
    const workflow = (t.startRun.mock.calls[0] as unknown as [{ name: string; steps: Array<{ command?: string; prompt?: string }> }])[0];
    expect(workflow.name).toBe('sdlc-baseline');
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0]?.command).toContain('sdlc baseline apply');
    expect(workflow.steps[0]?.prompt).toBeUndefined();
  });

  it('returns the task already in flight, including one waiting at review, instead of starting another', () => {
    const t = target();
    const open = run(t.store, 'sdlc-baseline');
    t.store.updateRun(open.id, { status: 'review' });
    expect(startAdoption(t)).toEqual({ runId: open.id });
    expect(t.startRun).not.toHaveBeenCalled();
  });

  it('starts a fresh task once the earlier one is finished, and ignores other workflows', () => {
    const t = target();
    const finished = run(t.store, 'sdlc-baseline');
    t.store.updateRun(finished.id, { status: 'done' });
    run(t.store, 'quick-task');
    expect(startAdoption(t)).toEqual({ runId: 'started' });
    expect(t.startRun).toHaveBeenCalledTimes(1);
  });
});
