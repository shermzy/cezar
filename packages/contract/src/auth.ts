import { z } from 'zod';

export const authMemberSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: z.enum(['owner', 'viewer']),
  status: z.enum(['active', 'suspended']),
  projectEntryIds: z.array(z.string().uuid()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AuthMember = z.infer<typeof authMemberSchema>;

export const authSessionResponseSchema = z.object({
  authRequired: z.boolean(),
  authenticated: z.boolean(),
  member: authMemberSchema.nullable(),
  csrfToken: z.string().optional(),
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const authLoginInputSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(1).max(1024),
});
export type AuthLoginInput = z.infer<typeof authLoginInputSchema>;

export const authLoginResponseSchema = z.object({ member: authMemberSchema });
export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>;

export const authInviteInputSchema = z.object({
  role: z.enum(['owner', 'viewer']),
  projectEntryIds: z.array(z.string().uuid()).max(500),
});
export type AuthInviteInput = z.infer<typeof authInviteInputSchema>;

export const authInviteResponseSchema = z.object({
  id: z.string().uuid(),
  token: z.string(),
  expiresAt: z.string(),
});
export type AuthInviteResponse = z.infer<typeof authInviteResponseSchema>;

export const authAcceptInviteInputSchema = z.object({
  token: z.string().min(32).max(128),
  username: z.string().min(2).max(32),
  password: z.string().min(12).max(1024),
});
export type AuthAcceptInviteInput = z.infer<typeof authAcceptInviteInputSchema>;

export const authAcceptInviteResponseSchema = z.object({ member: authMemberSchema });
export type AuthAcceptInviteResponse = z.infer<typeof authAcceptInviteResponseSchema>;

export const authMembersResponseSchema = z.object({
  members: z.array(authMemberSchema),
  projects: z.array(z.object({ entryId: z.string().uuid(), id: z.string(), name: z.string() })),
});
export type AuthMembersResponse = z.infer<typeof authMembersResponseSchema>;

export const authMemberIdParamsSchema = z.object({ id: z.string().uuid() });
export type AuthMemberIdParams = z.infer<typeof authMemberIdParamsSchema>;

export const authUpdateMemberInputSchema = z.object({
  role: z.enum(['owner', 'viewer']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  projectEntryIds: z.array(z.string().uuid()).max(500).optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined || value.projectEntryIds !== undefined);
export type AuthUpdateMemberInput = z.infer<typeof authUpdateMemberInputSchema>;

export const authMemberResponseSchema = z.object({ member: authMemberSchema });
export type AuthMemberResponse = z.infer<typeof authMemberResponseSchema>;

export const authRevokeSessionsResponseSchema = z.object({ revoked: z.literal(true) });
export type AuthRevokeSessionsResponse = z.infer<typeof authRevokeSessionsResponseSchema>;

export const viewerSummaryResponseSchema = z.object({
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    state: z.enum(['ok', 'missing', 'not-git']),
    recentRuns: z.object({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), latestAt: z.string().nullable() }),
  })),
});
export type ViewerSummaryResponse = z.infer<typeof viewerSummaryResponseSchema>;
