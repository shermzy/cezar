import { Hono } from 'hono';
import {
  sdlcBaselineRequestSchema,
  type SdlcAudit,
  type SdlcBaselineApply,
  type SdlcBaselinePlan,
} from '@open-mercato/cezar-contract';
import type { SdlcReader } from '../sdlc/reader.ts';
import { jsonZodValidator } from './validators.ts';

export type AdoptResult = { runId: string } | { error: string };

export interface SdlcRoutesDeps {
  reader: SdlcReader;
  /** Start the baseline adoption task for one project; never throws. */
  adopt: (projectId: string) => Promise<AdoptResult>;
  /** Writing is a local-machine capability, like agent-config writes. */
  localHandoff: () => boolean;
}

/**
 * The SDLC audit and baseline adoption (spec 2026-10-06-ai-native-sdlc-fleet). Workspace-level and
 * single-mount, like `/workspace/dashboard`: it answers for every registered project, so a
 * project-scoped spelling would be a second surface with no consumer.
 *
 * Keep the family chained: this return value is part of AppType and the typed client.
 */
export function sdlcRoutes(deps: SdlcRoutesDeps) {
  return new Hono()
    .get('/workspace/sdlc/audit', async (c) => {
      const body: SdlcAudit = await deps.reader.audit();
      return c.json(body);
    })
    .post('/workspace/sdlc/baseline/plan', jsonZodValidator(sdlcBaselineRequestSchema), async (c) => {
      const plan: SdlcBaselinePlan | null = await deps.reader.plan(c.req.valid('json').projectIds);
      return plan ? c.json(plan) : c.json({ error: 'Project not found' }, 404);
    })
    .post('/workspace/sdlc/baseline/apply', jsonZodValidator(sdlcBaselineRequestSchema), async (c) => {
      if (!deps.localHandoff()) {
        return c.json({ error: 'Adopting the baseline writes into local checkouts and is unavailable on a hosted cockpit' }, 409);
      }
      const known = await deps.reader.plan(c.req.valid('json').projectIds);
      if (!known) return c.json({ error: 'Project not found' }, 404);
      const runs: SdlcBaselineApply['runs'] = [];
      for (const projectId of new Set(c.req.valid('json').projectIds)) {
        const started = await deps.adopt(projectId);
        runs.push({ projectId, ...started });
        deps.reader.invalidateProject(projectId);
      }
      const body: SdlcBaselineApply = { runs };
      return c.json(body, 201);
    });
}
