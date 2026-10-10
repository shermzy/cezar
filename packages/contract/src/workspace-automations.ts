import { z } from 'zod';
import {
  automationDefinitionSchema,
  automationLogRecordSchema,
  createAutomationInputSchema,
  updateAutomationInputSchema,
} from './automations.ts';
import { automationScheduleSchema } from './automation-schedule.ts';

const targetEntryIdsSchema = z.array(z.string().uuid()).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'target repositories must be unique');

/** One canonical scheduled definition shared by the selected immutable registry entries. */
export const workspaceScheduleAutomationSchema = automationDefinitionSchema.extend({
  kind: z.literal('schedule'),
  schedule: automationScheduleSchema,
  targetEntryIds: targetEntryIdsSchema,
  /** Incremented when target-local schedule state must be reset; never accepted from clients. */
  workspaceRuntimeRevision: z.number().int().nonnegative().default(0),
});
export type WorkspaceScheduleAutomation = z.infer<typeof workspaceScheduleAutomationSchema>;

export const workspaceAutomationCreateSchema = createAutomationInputSchema.omit({ events: true, intervalSeconds: true, filters: true, trackerTrigger: true }).extend({
  kind: z.literal('schedule'),
  schedule: automationScheduleSchema,
  targetEntryIds: targetEntryIdsSchema,
});
export type WorkspaceAutomationCreate = z.input<typeof workspaceAutomationCreateSchema>;

export const workspaceAutomationUpdateSchema = updateAutomationInputSchema.omit({ events: true, intervalSeconds: true, filters: true, trackerTrigger: true }).extend({
  kind: z.literal('schedule'),
  schedule: automationScheduleSchema,
  targetEntryIds: targetEntryIdsSchema,
});
export type WorkspaceAutomationUpdate = z.input<typeof workspaceAutomationUpdateSchema>;

export const workspaceAutomationIdParamsSchema = z.object({ id: z.string().uuid() });

export const workspaceAutomationProjectSchema = z.object({
  targetEntryId: z.string().uuid(),
  projectId: z.string(),
  name: z.string(),
  available: z.boolean(),
});
export type WorkspaceAutomationProject = z.infer<typeof workspaceAutomationProjectSchema>;

export const workspaceAutomationTargetSchema = z.object({
  targetEntryId: z.string().uuid(),
  projectId: z.string().optional(),
  name: z.string(),
  status: z.enum(['scheduled', 'paused', 'auto-paused', 'unavailable']),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  latestLog: automationLogRecordSchema.optional(),
});
export type WorkspaceAutomationTarget = z.infer<typeof workspaceAutomationTargetSchema>;

export const workspaceAutomationEntrySchema = workspaceScheduleAutomationSchema.extend({
  targets: z.array(workspaceAutomationTargetSchema),
});
export type WorkspaceAutomationEntry = z.infer<typeof workspaceAutomationEntrySchema>;

export const workspaceAutomationsResponseSchema = z.object({
  projects: z.array(workspaceAutomationProjectSchema),
  automations: z.array(workspaceAutomationEntrySchema),
  timeZone: z.string(),
  scheduler: z.object({ state: z.enum(['scheduled', 'idle']), nextDue: z.string().optional() }),
});
export type WorkspaceAutomationsResponse = z.infer<typeof workspaceAutomationsResponseSchema>;

export const workspaceAutomationResponseSchema = z.object({ automation: workspaceScheduleAutomationSchema });
export type WorkspaceAutomationResponse = z.infer<typeof workspaceAutomationResponseSchema>;
