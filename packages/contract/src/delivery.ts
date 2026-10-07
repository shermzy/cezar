import { z } from 'zod';

/** The independently persisted delivery state for a run. */
export const deliveryStatusSchema = z.enum([
  'waiting-merge',
  'ci-pending',
  'ci-passed',
  'blocked',
  'unknown',
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/** A PR observed during an explicit delivery refresh. */
export const deliveryPrSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(['open', 'merged', 'closed']),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  baseRef: z.string().min(1),
  mergeCommitSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
});
export type DeliveryPr = z.infer<typeof deliveryPrSchema>;

/** One bounded Actions run used as evidence for a merged target commit. */
export const deliveryCheckSchema = z.object({
  workflow: z.string().min(1),
  runId: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
  branch: z.string().min(1),
  event: z.string().min(1),
  status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z.string().nullable(),
  url: z.string().url(),
});
export type DeliveryCheck = z.infer<typeof deliveryCheckSchema>;

/** Forge identity captured with the evidence so a remote change invalidates it. */
export const deliveryRepositorySchema = z.object({
  host: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
});
export type DeliveryRepository = z.infer<typeof deliveryRepositorySchema>;

/** Persisted result of a user-started, read-only delivery observation. */
export const deliveryRecordSchema = z.object({
  status: deliveryStatusSchema,
  startedAt: z.string(),
  checkedAt: z.string(),
  repository: deliveryRepositorySchema.optional(),
  prs: z.array(deliveryPrSchema).max(8),
  checks: z.array(deliveryCheckSchema).max(100),
  reason: z.string().optional(),
  stale: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;

/** POST /runs/:id/delivery/refresh accepts no controls: refresh is explicit and read-only. */
export const deliveryRefreshInputSchema = z.object({}).strict();
export type DeliveryRefreshInput = z.infer<typeof deliveryRefreshInputSchema>;

export const deliveryGetResponseSchema = deliveryRecordSchema.nullable();
export type DeliveryGetResponse = z.infer<typeof deliveryGetResponseSchema>;

export const deliveryRefreshResponseSchema = deliveryRecordSchema;
export type DeliveryRefreshResponse = z.infer<typeof deliveryRefreshResponseSchema>;
