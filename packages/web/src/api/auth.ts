import {
  API_PREFIX,
  authAcceptInviteResponseSchema,
  authInviteResponseSchema,
  authLoginResponseSchema,
  authMembersResponseSchema,
  authMemberResponseSchema,
  authRevokeSessionsResponseSchema,
  authSessionResponseSchema,
  viewerSummaryResponseSchema,
} from '@open-mercato/cezar-api-client'
import type {
  AuthAcceptInviteInput,
  AuthInviteInput,
  AuthLoginInput,
  AuthSessionResponse,
  AuthUpdateMemberInput,
  ViewerSummaryResponse,
} from '@open-mercato/cezar-api-client'
import { getApiBaseUrl } from '@open-mercato/cezar-api-client'
import { getAuthCsrfToken, setAuthCsrfToken } from './csrf'

const authPath = (path: string) => `${getApiBaseUrl()}${API_PREFIX}${path}`

async function read<T>(path: string, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await fetch(authPath(path), { credentials: 'include', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`)
  return schema.parse(body)
}

async function write<T>(path: string, body: unknown, schema: { parse(value: unknown): T }, includeCsrf = true, method = 'POST'): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = includeCsrf ? getAuthCsrfToken() : undefined
  if (csrf) headers.set('X-Cezar-CSRF', csrf)
  const response = await fetch(authPath(path), { method, credentials: 'include', cache: 'no-store', headers, body: JSON.stringify(body) })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof answer.error === 'string' ? answer.error : `Request failed (${response.status}).`)
  return schema.parse(answer)
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  const result = await read('/auth/session', authSessionResponseSchema)
  setAuthCsrfToken(result.csrfToken)
  return result
}

export async function signIn(input: AuthLoginInput): Promise<void> {
  await write('/auth/login', input, authLoginResponseSchema, false)
}

export async function acceptWorkspaceInvite(input: AuthAcceptInviteInput): Promise<void> {
  await write('/auth/invites/accept', input, authAcceptInviteResponseSchema, false)
}

export async function signOut(): Promise<void> {
  const headers = new Headers()
  const csrf = getAuthCsrfToken()
  if (csrf) headers.set('X-Cezar-CSRF', csrf)
  const response = await fetch(authPath('/auth/logout'), { method: 'POST', credentials: 'include', cache: 'no-store', headers })
  if (!response.ok) throw new Error(`Sign-out failed (${response.status}).`)
  setAuthCsrfToken(undefined)
}

export const getWorkspaceMembers = () => read('/auth/members', authMembersResponseSchema)
export const getViewerSummary = (): Promise<ViewerSummaryResponse> => read('/workspace/viewer-summary', viewerSummaryResponseSchema)
export const inviteWorkspaceMember = (input: AuthInviteInput) => write('/auth/invites', input, authInviteResponseSchema)

export async function updateWorkspaceMember(id: string, input: AuthUpdateMemberInput): Promise<void> {
  await write(`/auth/members/${encodeURIComponent(id)}`, input, authMemberResponseSchema, true, 'PATCH')
}

export async function revokeWorkspaceMemberSessions(id: string): Promise<void> {
  await write(`/auth/members/${encodeURIComponent(id)}/revoke-sessions`, {}, authRevokeSessionsResponseSchema)
}

export async function removeWorkspaceMember(id: string): Promise<void> {
  const headers = new Headers()
  const csrf = getAuthCsrfToken()
  if (csrf) headers.set('X-Cezar-CSRF', csrf)
  const response = await fetch(authPath(`/auth/members/${encodeURIComponent(id)}`), { method: 'DELETE', credentials: 'include', cache: 'no-store', headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`)
}
