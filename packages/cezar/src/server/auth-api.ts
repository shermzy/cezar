import { Hono } from 'hono';
import { isIP } from 'node:net';
import {
  authAcceptInviteInputSchema,
  authAcceptInviteResponseSchema,
  authInviteInputSchema,
  authInviteResponseSchema,
  authLoginInputSchema,
  authLoginResponseSchema,
  authMemberIdParamsSchema,
  authMemberResponseSchema,
  authMembersResponseSchema,
  authRevokeSessionsResponseSchema,
  authSessionResponseSchema,
  authUpdateMemberInputSchema,
  viewerSummaryResponseSchema,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator, paramZodValidator } from './validators.ts';
import {
  authStoreReady,
  acceptInvite,
  AuthStoreError,
  createInvite,
  csrfTokenForSession,
  findSession,
  listMembers,
  login,
  logout,
  removeMember,
  revokeMemberSessions,
  updateMember,
  type AuthMember,
  type AuthRole,
} from '../workspace/auth.ts';

export interface AuthApiProject {
  entryId: string;
  id: string;
  name: string;
}

export interface AuthViewerProject {
  id: string;
  name: string;
  state: 'ok' | 'missing' | 'not-git';
  recentRuns: { total: number; active: number; completed: number; failed: number; latestAt: string | null };
}

export interface AuthApiDeps {
  membershipProjects(): Promise<AuthApiProject[]>;
  viewerProjects(member: AuthMember): Promise<AuthViewerProject[]>;
  revokeUser?(userId: string): void;
  revokeCapabilities?(): void;
}

export function authSessionToken(cookie: string | undefined): string {
  const match = cookie?.match(/(?:^|;\s*)cezar_session=([^;]+)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]!); } catch { return ''; }
}

function setSessionCookie(c: { header(name: string, value: string): void }, token: string): void {
  c.header('Set-Cookie', `cezar_session=${encodeURIComponent(token)}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`);
}

function clearSessionCookie(c: { header(name: string, value: string): void }): void {
  c.header('Set-Cookie', 'cezar_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
}

function memberForRequest(cookie: string | undefined): AuthMember | null {
  const token = authSessionToken(cookie);
  return token ? findSession(token) : null;
}

function authAttemptSource(remoteAddress: string | undefined, xRealIp: string | undefined): string {
  const forwardedAddress = xRealIp?.trim();
  return process.env.CEZ_AUTH_TRUST_PROXY === '1' && forwardedAddress && isIP(forwardedAddress)
    ? forwardedAddress
    : remoteAddress ?? 'unknown';
}

export function createAuthRoutes(deps: AuthApiDeps) {
  const attempts = new Map<string, number[]>();
  const windowMs = 15 * 60_000;
  const maxSourceBuckets = 2000;
  const enabled = () => process.env.CEZ_AUTH_REQUIRED === '1';
  const disabled = (c: { json(body: { error: string }, status: 409): Response }) => c.json({ error: 'Managed access is disabled.' }, 409);
  const allowed = (keys: Array<{ key: string; limit: number }>): boolean => {
    const now = Date.now();
    for (const [candidate, times] of attempts) {
      const recent = times.filter((time) => now - time < windowMs);
      if (recent.length) attempts.set(candidate, recent);
      else attempts.delete(candidate);
    }
    const recentByKey = keys.map(({ key, limit }) => ({ key, limit, recent: attempts.get(key) ?? [] }));
    if (recentByKey.some(({ recent, limit }) => recent.length >= limit)) return false;
    // ponytail: cap memory at 2,000 attempt buckets; eviction shortens an old bucket's cooldown under source rotation.
    const newKeys = new Set(recentByKey.filter(({ key }) => !attempts.has(key)).map(({ key }) => key));
    while (attempts.size + newKeys.size > maxSourceBuckets) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
    for (const { key, recent } of recentByKey) {
      recent.push(now);
      attempts.set(key, recent);
    }
    return true;
  };

  return new Hono()
    .get('/auth/session', (c) => {
      if (!enabled()) return c.json(authSessionResponseSchema.parse({ authRequired: false, authenticated: false, member: null }));
      try {
        const token = authSessionToken(c.req.header('cookie'));
        const member = token ? findSession(token) : null;
        if (member && !authStoreReady()) return c.json({ error: 'Managed access is enabled but its store is unavailable. Repair it with the local Cezar auth command.' }, 503);
        return c.json(authSessionResponseSchema.parse({
          authRequired: process.env.CEZ_AUTH_REQUIRED === '1',
          authenticated: Boolean(member),
          member,
          ...(member && token ? { csrfToken: csrfTokenForSession(token) } : {}),
        }));
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        throw error;
      }
    })
    .post('/auth/login', jsonZodValidator(authLoginInputSchema), async (c) => {
      if (!enabled()) return disabled(c);
      const body = c.req.valid('json');
      const remoteAddress = (c.env as { incoming?: { socket?: { remoteAddress?: string } } }).incoming?.socket?.remoteAddress;
      const addr = authAttemptSource(remoteAddress, c.req.header('x-real-ip'));
      const username = body.username.trim().toLowerCase();
      if (!allowed([
        { key: `login-source:${addr}`, limit: 60 },
        { key: `login-user:${addr}:${username}`, limit: 12 },
      ])) return c.json({ error: 'Too many sign-in attempts. Try again later.' }, 429);
      if (!authStoreReady()) return c.json({ error: 'Managed access is enabled but its store is unavailable. Repair it with the local Cezar auth command.' }, 503);
      try {
        const result = await login(body.username, body.password);
        if (!result) return c.json({ error: 'Username or password is incorrect.' }, 401);
        setSessionCookie(c, result.token);
        return c.json(authLoginResponseSchema.parse({ member: result.member }));
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        throw error;
      }
    })
    .post('/auth/logout', async (c) => {
      if (!enabled()) {
        clearSessionCookie(c);
        return c.json({ ok: true as const });
      }
      const token = authSessionToken(c.req.header('cookie'));
      const member = token ? findSession(token) : null;
      if (token) await logout(token);
      if (member) deps.revokeUser?.(member.id);
      clearSessionCookie(c);
      return c.json({ ok: true as const });
    })
    .post('/auth/invites/accept', jsonZodValidator(authAcceptInviteInputSchema), async (c) => {
      if (!enabled()) return disabled(c);
      const body = c.req.valid('json');
      const remoteAddress = (c.env as { incoming?: { socket?: { remoteAddress?: string } } }).incoming?.socket?.remoteAddress;
      const addr = authAttemptSource(remoteAddress, c.req.header('x-real-ip'));
      if (!allowed([{ key: `invite-source:${addr}`, limit: 12 }])) return c.json({ error: 'Too many invitation attempts. Try again later.' }, 429);
      if (!authStoreReady()) return c.json({ error: 'Managed access is enabled but its store is unavailable. Repair it with the local Cezar auth command.' }, 503);
      try {
        const result = await acceptInvite(body.token, body.username, body.password);
        if (!result) return c.json({ error: 'This invitation is invalid, expired, or already used.' }, 400);
        setSessionCookie(c, result.token);
        c.header('Referrer-Policy', 'no-referrer');
        return c.json(authAcceptInviteResponseSchema.parse({ member: result.member }));
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        return c.json({ error: error instanceof Error ? error.message : 'Invitation could not be accepted.' }, 400);
      }
    })
    .get('/auth/members', async (c) => {
      if (!enabled()) return disabled(c);
      const actor = memberForRequest(c.req.header('cookie'));
      if (!actor || actor.role !== 'owner') return c.json({ error: 'Owner access required.' }, 403);
      try {
        const projects = await deps.membershipProjects();
        return c.json(authMembersResponseSchema.parse({ members: listMembers(), projects }));
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        throw error;
      }
    })
    .post('/auth/invites', jsonZodValidator(authInviteInputSchema), async (c) => {
      if (!enabled()) return disabled(c);
      const body = c.req.valid('json');
      const actor = memberForRequest(c.req.header('cookie'));
      if (!actor || actor.role !== 'owner') return c.json({ error: 'Owner access required.' }, 403);
      try {
        const projects = await deps.membershipProjects();
        const validIds = new Set(projects.map((project) => project.entryId));
        if (body.projectEntryIds.some((id) => !validIds.has(id))) return c.json({ error: 'Choose projects that are still registered.' }, 400);
        const invite = await createInvite(actor.id, body.role as AuthRole, body.projectEntryIds);
        return c.json(authInviteResponseSchema.parse(invite));
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        return c.json({ error: error instanceof Error ? error.message : 'Invitation could not be created.' }, 400);
      }
    })
    .patch('/auth/members/:id', paramZodValidator(authMemberIdParamsSchema), jsonZodValidator(authUpdateMemberInputSchema), async (c) => {
      if (!enabled()) return disabled(c);
      const actor = memberForRequest(c.req.header('cookie'));
      if (!actor || actor.role !== 'owner') return c.json({ error: 'Owner access required.' }, 403);
      const params = c.req.valid('param');
      const body = c.req.valid('json');
      try {
        if (body.projectEntryIds) {
          const projects = await deps.membershipProjects();
          const validIds = new Set(projects.map((project) => project.entryId));
          if (body.projectEntryIds.some((id) => !validIds.has(id))) return c.json({ error: 'Choose projects that are still registered.' }, 400);
        }
        const member = await updateMember(actor.id, params.id, body);
        if (member) {
          deps.revokeUser?.(member.id);
          deps.revokeCapabilities?.();
        }
        return member ? c.json(authMemberResponseSchema.parse({ member })) : c.json({ error: 'Member not found.' }, 404);
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        return c.json({ error: error instanceof Error ? error.message : 'Membership could not be updated.' }, 409);
      }
    })
    .post('/auth/members/:id/revoke-sessions', paramZodValidator(authMemberIdParamsSchema), async (c) => {
      if (!enabled()) return disabled(c);
      const actor = memberForRequest(c.req.header('cookie'));
      if (!actor || actor.role !== 'owner') return c.json({ error: 'Owner access required.' }, 403);
      try {
        const revoked = await revokeMemberSessions(actor.id, c.req.valid('param').id);
        if (revoked) {
          deps.revokeUser?.(c.req.valid('param').id);
          deps.revokeCapabilities?.();
        }
        return revoked
          ? c.json(authRevokeSessionsResponseSchema.parse({ revoked: true }))
          : c.json({ error: 'Member not found.' }, 404);
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        return c.json({ error: error instanceof Error ? error.message : 'Sessions could not be revoked.' }, 409);
      }
    })
    .delete('/auth/members/:id', paramZodValidator(authMemberIdParamsSchema), async (c) => {
      if (!enabled()) return disabled(c);
      const actor = memberForRequest(c.req.header('cookie'));
      if (!actor || actor.role !== 'owner') return c.json({ error: 'Owner access required.' }, 403);
      try {
        const removed = await removeMember(actor.id, c.req.valid('param').id);
        if (removed) {
          deps.revokeUser?.(c.req.valid('param').id);
          deps.revokeCapabilities?.();
        }
        return removed ? c.json({ removed: true as const }) : c.json({ error: 'Member not found.' }, 404);
      } catch (error) {
        if (error instanceof AuthStoreError) return c.json({ error: error.message }, 503);
        return c.json({ error: error instanceof Error ? error.message : 'Member could not be removed.' }, 409);
      }
    })
    .get('/workspace/viewer-summary', async (c) => {
      if (!enabled()) return disabled(c);
      const member = memberForRequest(c.req.header('cookie'));
      if (!member || member.role !== 'viewer') return c.json({ error: 'Viewer access required.' }, 403);
      const projects = await deps.viewerProjects(member);
      return c.json(viewerSummaryResponseSchema.parse({ projects }));
    });
}
