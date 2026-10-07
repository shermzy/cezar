/*
 * Failure matrix written before implementation:
 * - no authoritative PR association persists an honest unknown result;
 * - an open PR waits for merge, while a merge conflict blocks delivery;
 * - a merged PR with pending, failed, cancelled, skipped, or absent checks
 *   never becomes delivered;
 * - only completed successful checks for the exact merged SHA and target
 *   branch establish delivered;
 * - an unavailable refresh preserves previous evidence but marks it stale;
 * - multiple authoritative PRs are evaluated together;
 * - a concurrent association change cannot write an observation for the old
 *   association;
 * - the delivery record survives a RunStore restart.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeDeliveryRef, ForgeDriver } from '../server/forge/types.js';
import { RunStore } from '../runs/store.js';
import {
  DeliveryService,
  type ForgeDeliveryObservation,
} from './service.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const roots: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.flush();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'cezar-delivery-service-'));
  roots.push(root);
  const store = await RunStore.open(root);
  stores.push(store);
  const run = store.createRun({
    title: 'track delivery',
    workflow: 'default',
    task: 'track delivery',
    steps: [],
  });
  return { root, store, run };
}

function fakeForge(observation: ForgeDeliveryObservation): ForgeDriver {
  return { observeDelivery: async () => observation } as unknown as ForgeDriver;
}

function mergedPr(number: number, mergeCommitSha = SHA_A) {
  return {
    number,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: 'merged' as const,
    mergeable: 'mergeable' as const,
    baseRef: 'main',
    mergeCommitSha,
  };
}

function openPr(number: number, mergeable: 'mergeable' | 'conflicting' = 'mergeable') {
  return {
    number,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: 'open' as const,
    mergeable,
    baseRef: 'main',
  };
}

function check(conclusion: string | null, sha = SHA_A) {
  return {
    workflow: 'CI',
    runId: 42,
    runAttempt: 1,
    sha,
    branch: 'main',
    event: 'push',
    status: conclusion === null ? ('in_progress' as const) : ('completed' as const),
    conclusion,
    url: 'https://github.com/acme/repo/actions/runs/42',
  };
}

describe('DeliveryService', () => {
  it('persists unknown when no authoritative PR is associated', async () => {
    const { root, store, run } = await makeStore();
    const service = new DeliveryService(async () => fakeForge({ available: true, prs: [], checks: [] }));

    const delivery = await service.refresh(root, store, run.id);

    expect(delivery.status).toBe('unknown');
    expect(delivery.reason).toMatch(/authoritative/i);
    expect((await store.getRun(run.id))?.delivery).toEqual(delivery);
  });

  it('uses a legacy marker PR when the persisted ref list does not contain it', async () => {
    const { root, store, run } = await makeStore();
    store.updateRun(run.id, { markerRefs: { pr: 15 } });
    let seen: number[] = [];
    const service = new DeliveryService(async () => ({
      observeDelivery: async (refs: readonly ForgeDeliveryRef[]) => {
        seen = refs.map((ref) => ref.number);
        return { available: true, prs: [mergedPr(15)], checks: [check('success')] };
      },
    } as unknown as ForgeDriver));

    const delivery = await service.refresh(root, store, run.id);

    expect(seen).toEqual([15]);
    expect(delivery.status).toBe('ci-passed');
  });

  it('waits for an open PR and blocks a conflicting PR', async () => {
    const first = await makeStore();
    await first.store.recordPrRef(first.run.id, {
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
      origin: 'created',
    });
    const waiting = new DeliveryService(async () => fakeForge({ available: true, prs: [openPr(7)], checks: [] }));
    expect((await waiting.refresh(first.root, first.store, first.run.id)).status).toBe('waiting-merge');

    const second = await makeStore();
    await second.store.recordPrRef(second.run.id, {
      number: 8,
      url: 'https://github.com/acme/repo/pull/8',
      origin: 'marker',
    });
    const blocked = new DeliveryService(async () => fakeForge({ available: true, prs: [openPr(8, 'conflicting')], checks: [] }));
    const delivery = await blocked.refresh(second.root, second.store, second.run.id);
    expect(delivery.status).toBe('blocked');
    expect(delivery.reason).toMatch(/conflict/i);
  });

  it('requires exact target-branch push evidence for delivered', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 9,
      url: 'https://github.com/acme/repo/pull/9',
      origin: 'created',
    });
    const forge = (observation: ForgeDeliveryObservation) => new DeliveryService(async () => fakeForge(observation));

    expect((await forge({ available: true, prs: [mergedPr(9)], checks: [check(null)] }).refresh(root, store, run.id)).status)
      .toBe('ci-pending');
    expect((await forge({ available: true, prs: [mergedPr(9)], checks: [check('failure')] }).refresh(root, store, run.id)).status)
      .toBe('blocked');
    expect((await forge({ available: true, prs: [mergedPr(9)], checks: [] }).refresh(root, store, run.id)).status)
      .toBe('unknown');
    expect((await forge({ available: true, prs: [mergedPr(9)], checks: [check('success', SHA_B)] }).refresh(root, store, run.id)).status)
      .toBe('unknown');
    expect((await forge({ available: true, prs: [mergedPr(9)], checks: [check('success')] }).refresh(root, store, run.id)).status)
      .toBe('ci-passed');
  });

  it('evaluates all authoritative PRs and excludes display-only references', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 10,
      url: 'https://github.com/acme/repo/pull/10',
      origin: 'created',
    });
    store.updateRun(run.id, {
      referencedPullRequestUrl: 'https://github.com/acme/repo/pull/999',
      prNumber: 999,
    });
    let seen: number[] = [];
    const service = new DeliveryService(async () => ({
      observeDelivery: async (refs: readonly ForgeDeliveryRef[]) => {
        seen = refs.map((ref) => ref.number);
        return { available: true, prs: [mergedPr(10)], checks: [check('success')] };
      },
    } as unknown as ForgeDriver));

    const delivery = await service.refresh(root, store, run.id);

    expect(seen).toEqual([10]);
    expect(delivery.status).toBe('ci-passed');
  });

  it('keeps old evidence stale when refresh is unavailable', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 11,
      url: 'https://github.com/acme/repo/pull/11',
      origin: 'created',
    });
    const good = new DeliveryService(async () => fakeForge({ available: true, prs: [mergedPr(11)], checks: [check('success')] }));
    const prior = await good.refresh(root, store, run.id);
    const unavailable = new DeliveryService(async () => fakeForge({
      available: false,
      reason: 'GitHub unavailable',
      repository: { host: 'github.com', owner: 'other', name: 'repo', url: 'https://github.com/other/repo' },
    }));

    const delivery = await unavailable.refresh(root, store, run.id);

    expect(delivery.status).toBe('unknown');
    expect(delivery.stale).toBe(true);
    expect(delivery.prs).toEqual(prior.prs);
    expect(delivery.checks).toEqual(prior.checks);
    expect(delivery.repository).toEqual(prior.repository);
  });

  it('does not label a first unavailable refresh as stale', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 16,
      url: 'https://github.com/acme/repo/pull/16',
      origin: 'created',
    });
    const service = new DeliveryService(async () => fakeForge({ available: false, reason: 'GitHub unavailable' }));

    const delivery = await service.refresh(root, store, run.id);

    expect(delivery.status).toBe('unknown');
    expect(delivery.stale).toBeUndefined();
  });

  const associationMutations: Array<[string, (store: RunStore, runId: string) => unknown]> = [
    ['recordPrRef', (store: RunStore, runId: string) => store.recordPrRef(runId, {
      number: 32,
      url: 'https://github.com/acme/repo/pull/32',
      origin: 'created',
    })],
    ['pullRequestUrl', (store: RunStore, runId: string) => store.updateRun(runId, {
      pullRequestUrl: 'https://github.com/acme/repo/pull/33',
    })],
    ['markerRefs', (store: RunStore, runId: string) => store.updateRun(runId, { markerRefs: { pr: 34 } })],
  ];

  it.each(associationMutations)('invalidates stored evidence when %s changes the authoritative association', async (_mutation, mutate) => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 31,
      url: 'https://github.com/acme/repo/pull/31',
      origin: 'created',
    });
    const service = new DeliveryService(async () => fakeForge({ available: true, prs: [mergedPr(31)], checks: [check('success')] }));
    const prior = await service.refresh(root, store, run.id);
    expect(prior.status).toBe('ci-passed');

    mutate(store, run.id);

    const invalidated = (await store.getRun(run.id))?.delivery;
    expect(invalidated?.status).toBe('unknown');
    expect(invalidated?.stale).toBe(true);
    expect(invalidated?.prs).toEqual(prior.prs);
    expect(invalidated?.checks).toEqual(prior.checks);
  });

  it('recovers with new evidence after the linked repository changes', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 31,
      url: 'https://github.com/acme/repo/pull/31',
      origin: 'created',
    });
    let observation: ForgeDeliveryObservation = {
      available: true,
      prs: [mergedPr(31)],
      checks: [check('success')],
    };
    const service = new DeliveryService(async () => fakeForge(observation));
    const prior = await service.refresh(root, store, run.id);
    expect(prior.status).toBe('ci-passed');

    observation = {
      available: true,
      prs: [{ ...mergedPr(31), url: 'https://github.com/other/new-repo/pull/31' }],
      checks: [check('success')],
    };
    const stale = await service.refresh(root, store, run.id);
    expect(stale.status).toBe('unknown');
    expect(stale.stale).toBe(true);
    expect(stale.repository).toMatchObject({ owner: 'acme', name: 'repo' });
    expect(stale.prs).toEqual(prior.prs);

    const recovered = await service.refresh(root, store, run.id);
    expect(recovered.status).toBe('ci-passed');
    expect(recovered.repository).toMatchObject({ owner: 'other', name: 'new-repo' });
    expect(recovered.prs[0]?.url).toBe('https://github.com/other/new-repo/pull/31');
    expect(recovered.stale).toBeUndefined();
  });

  it('does not write an observation after the association changes in flight', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 12,
      url: 'https://github.com/acme/repo/pull/12',
      origin: 'created',
    });
    const initial = new DeliveryService(async () => fakeForge({ available: true, prs: [mergedPr(12)], checks: [check('success')] }));
    const prior = await initial.refresh(root, store, run.id);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const service = new DeliveryService(async () => ({
      observeDelivery: async () => {
        await waiting;
        return { available: true, prs: [mergedPr(12)], checks: [check('success')] };
      },
    } as unknown as ForgeDriver));

    const refresh = service.refresh(root, store, run.id);
    await store.recordPrRef(run.id, {
      number: 13,
      url: 'https://github.com/acme/repo/pull/13',
      origin: 'created',
    });
    release();

    await expect(refresh).rejects.toThrow(/association/i);
    const invalidated = (await store.getRun(run.id))?.delivery;
    expect(invalidated?.status).toBe('unknown');
    expect(invalidated?.stale).toBe(true);
    expect(invalidated?.prs).toEqual(prior.prs);
  });

  it('survives a RunStore restart', async () => {
    const { root, store, run } = await makeStore();
    await store.recordPrRef(run.id, {
      number: 14,
      url: 'https://github.com/acme/repo/pull/14',
      origin: 'created',
    });
    const service = new DeliveryService(async () => fakeForge({ available: true, prs: [mergedPr(14)], checks: [check('success')] }));
    const expected = await service.refresh(root, store, run.id);
    await store.flush();
    const reopened = await RunStore.open(root);

    expect((await reopened.getRun(run.id))?.delivery).toEqual(expected);
  });
});
