/*
 * API failure matrix written before implementation:
 * - GET is stored-only and returns null before explicit tracking;
 * - POST accepts only an empty object (or an absent JSON body) and persists
 *   the refresh result;
 * - malformed JSON fields are rejected by route middleware;
 * - the delivery routes are visible through the typed, versioned app;
 * - an unknown run remains a 404 and does not cross project scope.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeDriver } from './forge/types.js';
import { createApp } from './server.js';
import { RunStore } from '../runs/store.js';
import { ProjectContexts } from './project-context.js';
import { deliveryRefreshResponseSchema } from '@open-mercato/cezar-contract';

const roots: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.flush();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('delivery API', () => {
  it('returns null until explicitly refreshed, then persists the result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-delivery-api-'));
    roots.push(root);
    const store = await RunStore.open(root);
    stores.push(store);
    const run = store.createRun({ title: 'delivery api', workflow: 'default', task: 'delivery api', steps: [] });
    store.recordPrRef(run.id, {
      number: 21,
      url: 'https://github.com/acme/repo/pull/21',
      origin: 'created',
    });

    const app = createApp({
      repoRoot: root,
      store,
      manager: {} as never,
      version: '0.0.0-test',
      deliveryForge: async () => ({
        observeDelivery: async () => ({
          available: true,
          prs: [{
            number: 21,
            url: 'https://github.com/acme/repo/pull/21',
            state: 'merged',
            mergeable: 'mergeable',
            baseRef: 'main',
            mergeCommitSha: 'a'.repeat(40),
          }],
          checks: [{
            workflow: 'CI',
            runId: 21,
            runAttempt: 1,
            sha: 'a'.repeat(40),
            branch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/acme/repo/actions/runs/21',
          }],
        }),
      } as unknown as ForgeDriver),
    });
    const localHeaders = { host: 'localhost' };

    const before = await app.request(`/api/v1/runs/${run.id}/delivery`, { headers: localHeaders });
    expect(before.status).toBe(200);
    expect(await before.json()).toBeNull();

    const invalid = await app.request(`/api/v1/runs/${run.id}/delivery/refresh`, {
      method: 'POST',
      headers: { ...localHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(invalid.status).toBe(400);

    const refreshed = await app.request(`/api/v1/runs/${run.id}/delivery/refresh`, {
      method: 'POST',
      headers: { ...localHeaders, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(refreshed.status).toBe(200);
    expect(deliveryRefreshResponseSchema.parse(await refreshed.json()).status).toBe('ci-passed');

    const after = await app.request(`/api/v1/runs/${run.id}/delivery`, { headers: localHeaders });
    expect(deliveryRefreshResponseSchema.parse(await after.json()).status).toBe('ci-passed');
  });

  it('answers through the scoped family and keeps unknown runs isolated', async () => {
    const bootRoot = await mkdtemp(join(tmpdir(), 'cezar-delivery-api-boot-'));
    roots.push(bootRoot);
    const store = await RunStore.open(bootRoot);
    stores.push(store);
    const run = store.createRun({ title: 'scoped delivery', workflow: 'default', task: 'scoped delivery', steps: [] });
    const contexts = new ProjectContexts({
      listProjects: async () => [],
    });
    const app = createApp({
      repoRoot: bootRoot,
      store,
      manager: {} as never,
      version: '0.0.0-test',
      contexts,
      deliveryForge: async () => ({ observeDelivery: async () => ({ available: true, prs: [], checks: [] }) } as unknown as ForgeDriver),
    });
    const localHeaders = { host: 'localhost' };

    const scoped = await app.request(`/api/v1/p/default/runs/${run.id}/delivery`, { headers: localHeaders });
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toBeNull();
    const unknownProject = await app.request(`/api/v1/p/other/runs/${run.id}/delivery`, { headers: localHeaders });
    expect(unknownProject.status).toBe(404);
  });

  it('returns 404 when a run is deleted while refresh is observing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-delivery-api-delete-'));
    roots.push(root);
    const store = await RunStore.open(root);
    stores.push(store);
    const run = store.createRun({ title: 'deleted delivery', workflow: 'default', task: 'deleted delivery', steps: [] });
    store.recordPrRef(run.id, {
      number: 22,
      url: 'https://github.com/acme/repo/pull/22',
      origin: 'created',
    });
    let release!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const app = createApp({
      repoRoot: root,
      store,
      manager: {} as never,
      version: '0.0.0-test',
      deliveryForge: async () => ({
        observeDelivery: async () => {
          enteredResolve();
          await waiting;
          return { available: true, prs: [], checks: [] };
        },
      } as unknown as ForgeDriver),
    });
    const refresh = app.request(`/api/v1/runs/${run.id}/delivery/refresh`, {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    });
    await entered;
    expect(store.deleteRun(run.id)).toBe(true);
    release();

    const response = await refresh;

    expect(response.status).toBe(404);
    expect(store.getRun(run.id)).toBeUndefined();
  });
});
