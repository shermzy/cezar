import { basename } from 'node:path';
import type { SdlcAudit, SdlcBaselinePlan, SdlcProjectAudit } from '@open-mercato/cezar-contract';
import { baselineAudit, loadBaseline, planBaseline, type Baseline } from './baseline.ts';
import { PLAYS, nextMove } from './plays.ts';
import { scanProject } from './scan.ts';

/** Same horizon as the dashboard snapshot: long enough to coalesce a burst of tab opens. */
const TTL_MS = 60_000;
const CONCURRENCY = 8;

export interface SdlcProject {
  id: string;
  root: string;
  name?: string;
}

export interface SdlcReaderDeps {
  projects: () => Promise<readonly SdlcProject[]>;
  /** Production loads the shipped baseline (or the user's override); tests inject a tiny one. */
  baseline?: () => Promise<Baseline>;
  now?: () => number;
}

interface Cached {
  root: string;
  baselineVersion: number;
  at: number;
  audit: SdlcProjectAudit;
}

/**
 * Workspace-level reader for the SDLC audit (spec 2026-10-06-ai-native-sdlc-fleet). Demand-driven
 * like the dashboard: nothing is scanned until a client asks, and a project's answer is reused for
 * 60 seconds. Read-only — the only writer in this feature is the adoption task, in its worktree.
 */
export class SdlcReader {
  private readonly cache = new Map<string, Cached>();
  private readonly loadBaselineFn: () => Promise<Baseline>;
  private readonly now: () => number;

  constructor(private readonly deps: SdlcReaderDeps) {
    this.loadBaselineFn = deps.baseline ?? (() => loadBaseline());
    this.now = deps.now ?? Date.now;
  }

  async audit(): Promise<SdlcAudit> {
    const [projects, baseline] = await Promise.all([this.deps.projects(), this.loadBaselineFn()]);
    const audits: SdlcProjectAudit[] = new Array(projects.length);
    let cursor = 0;
    const worker = async () => {
      for (let i = cursor++; i < projects.length; i = cursor++) {
        audits[i] = await this.project(projects[i] as SdlcProject, baseline);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, projects.length) }, worker));
    // Drop cache rows for projects that left the registry.
    const live = new Set(projects.map((p) => p.id));
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    return { baselineVersion: baseline.version, plays: [...PLAYS], projects: audits };
  }

  /** What adopting would do per project, or null when any id is not a registered project. */
  async plan(projectIds: readonly string[]): Promise<SdlcBaselinePlan | null> {
    const [projects, baseline] = await Promise.all([this.deps.projects(), this.loadBaselineFn()]);
    const byId = new Map(projects.map((p) => [p.id, p]));
    const out: SdlcBaselinePlan['projects'] = [];
    for (const id of new Set(projectIds)) {
      const project = byId.get(id);
      if (!project) return null;
      out.push({ projectId: id, files: await planBaseline(project.root, baseline).catch(() => []) });
    }
    return { projects: out };
  }

  invalidateProject(id: string): void {
    this.cache.delete(id);
  }

  private async project(project: SdlcProject, baseline: Baseline): Promise<SdlcProjectAudit> {
    const hit = this.cache.get(project.id);
    // The baseline version is part of the key: swapping `~/.cezar/sdlc-baseline/` changes every
    // project's baseline state without touching a single repo file.
    if (hit && hit.root === project.root && hit.baselineVersion === baseline.version && this.now() - hit.at < TTL_MS) {
      return hit.audit;
    }
    const scan = await scanProject(project.root);
    const audit: SdlcProjectAudit = {
      projectId: project.id,
      name: project.name || basename(project.root),
      status: scan.status,
      scannedAt: new Date(this.now()).toISOString(),
      results: scan.results,
      baseline: scan.status === 'ok' ? await baselineAudit(project.root, baseline) : { state: 'none', files: [] },
      ...(scan.status === 'ok' && nextMove(scan.results) ? { next: nextMove(scan.results) } : {}),
    };
    this.cache.set(project.id, { root: project.root, baselineVersion: baseline.version, at: this.now(), audit });
    return audit;
  }
}
