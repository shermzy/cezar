import type {
  DeliveryCheck,
  DeliveryPr,
  DeliveryRecord,
  DeliveryRepository,
} from '@open-mercato/cezar-contract';
import { authoritativePrRefs, prAssociationSignature } from '../runs/store.ts';
import type { RunStore } from '../runs/store.ts';
import type {
  ForgeDeliveryObservation,
  ForgeDeliveryRef,
  ForgeDriver,
} from '../server/forge/types.ts';

export type { ForgeDeliveryObservation };

type ResolveForge = (repoRoot: string) => Promise<ForgeDriver | null>;

/**
 * Read-only delivery reconciliation. The map is deliberately local to the app
 * instance and keyed by project root plus run id, so one refresh cannot race a
 * second request for the same persisted record or cross project boundaries.
 */
export class DeliveryService {
  private readonly inFlight = new Map<string, Promise<DeliveryRecord>>();

  constructor(private readonly resolveForge: ResolveForge) {}

  refresh(repoRoot: string, store: RunStore, runId: string): Promise<DeliveryRecord> {
    const key = `${repoRoot}\0${runId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.refreshOnce(repoRoot, store, runId).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async refreshOnce(repoRoot: string, store: RunStore, runId: string): Promise<DeliveryRecord> {
    const initial = store.getRun(runId);
    if (!initial) throw new Error(`run not found: ${runId}`);
    const refs = authoritativePrRefs(initial).map((ref) => ({
      number: ref.number,
      ...(ref.url ? { url: ref.url } : {}),
    }));
    const signature = prAssociationSignature(initial);
    const previous = initial.delivery;
    const checkedAt = new Date().toISOString();

    if (refs.length === 0) {
      return this.writeIfCurrent(store, runId, signature, unknownRecord(previous, checkedAt, 'No authoritative pull request is associated with this run.', previous?.repository, previous !== undefined));
    }
    if (refs.length > 8) {
      const record = unknownRecord(
        previous,
        checkedAt,
        'More than eight authoritative pull requests are associated with this run.',
        previous?.repository,
        previous !== undefined,
      );
      return this.writeIfCurrent(store, runId, signature, { ...record, truncated: true });
    }

    let observation: ForgeDeliveryObservation;
    try {
      const forge = await this.resolveForge(repoRoot);
      if (!forge?.observeDelivery) {
        observation = { available: false, reason: 'The configured forge cannot observe delivery evidence.' };
      } else {
        observation = await forge.observeDelivery(refs);
      }
    } catch (error) {
      observation = { available: false, reason: error instanceof Error ? error.message : 'Forge observation failed.' };
    }

    const current = store.getRun(runId);
    if (!current) throw new Error(`run not found: ${runId}`);
    if (prAssociationSignature(current) !== signature) {
      throw new Error('delivery association changed during refresh');
    }

    if (!observation.available) {
      return this.writeIfCurrent(
        store,
        runId,
        signature,
        unknownRecord(previous, checkedAt, observation.reason, previous?.repository ?? observation.repository, previous !== undefined),
      );
    }

    const repository = observation.repository ?? commonRepository(observation.prs);
    const repositoryMatchesPrs = observation.prs.every((pr) => {
      const prRepository = repositoryFromUrl(pr.url);
      return prRepository !== undefined && (repository === undefined || repositoryKey(prRepository) === repositoryKey(repository));
    });
    if (!repositoryMatchesPrs) {
      return this.writeIfCurrent(
        store,
        runId,
        signature,
        unknownRecord(previous, checkedAt, 'The forge returned evidence for an unknown or different repository.', previous?.repository ?? repository, previous !== undefined),
      );
    }
    if (previous?.repository && !previous.stale && repository && repositoryKey(previous.repository) !== repositoryKey(repository)) {
      return this.writeIfCurrent(
        store,
        runId,
        signature,
        unknownRecord(previous, checkedAt, 'The linked repository changed; previous delivery evidence is stale.', previous.repository, true),
      );
    }

    const prs = observation.prs.slice(0, 8);
    const checks = observation.checks.slice(0, 100);
    const evaluated = evaluate(refs, prs, checks, observation.truncated === true || observation.prs.length > 8 || observation.checks.length > 100);
    const record: DeliveryRecord = {
      status: evaluated.status,
      startedAt: previous?.startedAt ?? checkedAt,
      checkedAt,
      prs,
      checks,
      ...(repository ? { repository } : {}),
      ...(evaluated.reason ? { reason: evaluated.reason } : {}),
      ...(evaluated.truncated ? { truncated: true } : {}),
    };
    return this.writeIfCurrent(store, runId, signature, record);
  }

  private writeIfCurrent(store: RunStore, runId: string, signature: string, record: DeliveryRecord): DeliveryRecord {
    const current = store.getRun(runId);
    if (!current) throw new Error(`run not found: ${runId}`);
    if (prAssociationSignature(current) !== signature) {
      throw new Error('delivery association changed during refresh');
    }
    store.updateRun(runId, { delivery: record });
    return record;
  }
}

function unknownRecord(
  previous: DeliveryRecord | undefined,
  checkedAt: string,
  reason: string,
  repository: DeliveryRepository | undefined,
  stale = false,
): DeliveryRecord {
  return {
    status: 'unknown',
    startedAt: previous?.startedAt ?? checkedAt,
    checkedAt,
    prs: previous?.prs ?? [],
    checks: previous?.checks ?? [],
    ...(repository ? { repository } : {}),
    reason,
    ...(stale ? { stale: true } : {}),
    ...(previous?.truncated ? { truncated: true } : {}),
  };
}

function evaluate(
  refs: readonly ForgeDeliveryRef[],
  prs: readonly DeliveryPr[],
  checks: readonly DeliveryCheck[],
  truncated: boolean,
): { status: DeliveryRecord['status']; reason?: string; truncated?: boolean } {
  if (truncated) return { status: 'unknown', reason: 'Delivery evidence was truncated before all checks could be read.', truncated: true };
  const observed = refs.map((ref) => prs.find((pr) => pr.number === ref.number));
  if (observed.some((pr) => !pr)) return { status: 'unknown', reason: 'One or more linked pull requests could not be read.' };
  const complete = observed.filter(isDeliveryPr);
  if (complete.length !== observed.length) return { status: 'unknown', reason: 'One or more linked pull requests could not be read.' };
  if (complete.some((pr) => pr.state === 'closed')) return { status: 'blocked', reason: 'A linked pull request closed without merging.' };
  if (complete.some((pr) => pr.state === 'open' && pr.mergeable === 'conflicting')) {
    return { status: 'blocked', reason: 'A linked pull request has merge conflicts.' };
  }
  if (complete.some((pr) => pr.state === 'open')) return { status: 'waiting-merge', reason: 'Waiting for all linked pull requests to merge.' };
  const merged = complete.filter((pr) => pr.state === 'merged');
  if (merged.some((pr) => pr.mergeCommitSha === undefined)) return { status: 'unknown', reason: 'The forge did not provide a merged commit SHA.' };

  const exactChecks: DeliveryCheck[] = [];
  for (const pr of merged) {
    const mergeCommitSha = pr.mergeCommitSha;
    if (!mergeCommitSha) return { status: 'unknown', reason: 'The forge did not provide a merged commit SHA.' };
    const matching = checks.filter((check) =>
      check.sha.toLowerCase() === mergeCommitSha.toLowerCase()
      && check.branch === pr.baseRef
      && check.event === 'push',
    );
    if (matching.length === 0) return { status: 'unknown', reason: 'No complete target-branch push checks were found for a merged commit.' };
    exactChecks.push(...matching);
  }
  if (exactChecks.some((check) => check.status === 'queued' || check.status === 'in_progress')) {
    return { status: 'ci-pending', reason: 'Target-branch CI is still running.' };
  }
  if (exactChecks.some((check) => check.status !== 'completed' || check.conclusion === null || check.conclusion === 'unknown')) {
    return { status: 'unknown', reason: 'Target-branch CI returned incomplete or unknown evidence.' };
  }
  if (exactChecks.some((check) => check.conclusion !== 'success')) {
    return { status: 'blocked', reason: 'Target-branch CI did not pass.' };
  }
  return { status: 'ci-passed' };
}

function isDeliveryPr(value: DeliveryPr | undefined): value is DeliveryPr {
  return value !== undefined;
}

function commonRepository(prs: readonly DeliveryPr[]): DeliveryRepository | undefined {
  const repositories = prs.map((pr) => repositoryFromUrl(pr.url)).filter((value): value is DeliveryRepository => value !== undefined);
  if (repositories.length === 0) return undefined;
  const firstRepository = repositories.shift();
  if (firstRepository === undefined) return undefined;
  const first = repositoryKey(firstRepository);
  return repositories.every((repo) => repositoryKey(repo) === first) ? firstRepository : undefined;
}

function repositoryFromUrl(value: string): DeliveryRepository | undefined {
  try {
    const url = new URL(value);
    const [owner, name] = url.pathname.split('/').filter(Boolean);
    if (!owner || !name) return undefined;
    return { host: url.host.toLowerCase(), owner, name, url: `${url.protocol}//${url.host}/${owner}/${name}` };
  } catch {
    return undefined;
  }
}

function repositoryKey(repository: DeliveryRepository): string {
  return `${repository.host.toLowerCase()}/${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}
