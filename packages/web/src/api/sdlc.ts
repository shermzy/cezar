import { useQuery } from '@tanstack/react-query'
import {
  sdlcAuditSchema,
  sdlcBaselineApplySchema,
  sdlcBaselinePlanSchema,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'
import { workspaceQueryKeys } from './queries'

export const sdlcKeys = {
  audit: [...workspaceQueryKeys.dashboard, 'sdlc'] as const,
}

export async function getSdlcAudit(signal?: AbortSignal) {
  return sdlcAuditSchema.parse(
    await unwrap(
      await cez.api.v1.workspace.sdlc.audit.$get({}, { init: { signal } }),
      '/workspace/sdlc/audit',
    ),
  )
}

export async function planSdlcBaseline(projectIds: string[]) {
  return sdlcBaselinePlanSchema.parse(
    await unwrap(
      await cez.api.v1.workspace.sdlc.baseline.plan.$post({ json: { projectIds } }),
      '/workspace/sdlc/baseline/plan',
    ),
  )
}

export async function applySdlcBaseline(projectIds: string[]) {
  return sdlcBaselineApplySchema.parse(
    await unwrap(
      await cez.api.v1.workspace.sdlc.baseline.apply.$post({ json: { projectIds } }),
      '/workspace/sdlc/baseline/apply',
    ),
  )
}

/**
 * The fleet audit. Fetched on open and on an explicit refresh only: the server caches each
 * project for a minute and the scan is cheap, so a poll or a socket topic would buy nothing.
 */
export function useSdlcAudit(enabled = true) {
  return useQuery({
    queryKey: sdlcKeys.audit,
    queryFn: ({ signal }) => getSdlcAudit(signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  })
}
