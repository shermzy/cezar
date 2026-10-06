import { z } from 'zod';

/**
 * `GET /workspace/sdlc/audit` and the baseline adoption routes (spec 2026-10-06-ai-native-sdlc-fleet).
 *
 * The audit is a deterministic, read-only scan of every registered project against the AI-native
 * SDLC playbook's plays. Nothing here is scored by an agent: a cell is explainable from its
 * `evidence` paths alone.
 */
const iso = z.iso.datetime();

export const sdlcPlayIdSchema = z.enum([
  'intent',
  'spec',
  'plan',
  'claude-md',
  'skills',
  'build-hooks',
  'subagents',
  'feedback-loop',
  'config-evals',
  'agent-review',
  'approval-gates',
  'ci-agent-jobs',
  'close-the-loop',
  'recurring-scans',
]);
export type SdlcPlayId = z.infer<typeof sdlcPlayIdSchema>;

export const sdlcStageSchema = z.enum(['plan', 'design', 'build', 'test', 'deploy', 'maintain']);
export type SdlcStage = z.infer<typeof sdlcStageSchema>;

export const sdlcScoreSchema = z.enum(['absent', 'partial', 'present']);
export type SdlcScore = z.infer<typeof sdlcScoreSchema>;

/** One catalog entry. The catalog travels with the answer so the cockpit never hard-codes it. */
export const sdlcPlaySchema = z.object({
  id: sdlcPlayIdSchema,
  stage: sdlcStageSchema,
  title: z.string().min(1).max(80),
  prereqs: z.array(sdlcPlayIdSchema).max(8),
});
export type SdlcPlay = z.infer<typeof sdlcPlaySchema>;

export const sdlcPlayResultSchema = z.object({
  play: sdlcPlayIdSchema,
  score: sdlcScoreSchema,
  /** Repo-relative paths that justify the score, at most five. */
  evidence: z.array(z.string().max(300)).max(5),
  note: z.string().max(200).optional(),
});
export type SdlcPlayResult = z.infer<typeof sdlcPlayResultSchema>;

export const sdlcBaselineFileStateSchema = z.enum(['untouched', 'diverged', 'missing']);
export type SdlcBaselineFileState = z.infer<typeof sdlcBaselineFileStateSchema>;

export const sdlcBaselineSchema = z.object({
  state: z.enum(['none', 'current', 'outdated', 'diverged']),
  version: z.number().int().nonnegative().optional(),
  files: z
    .array(z.object({ path: z.string().max(300), state: sdlcBaselineFileStateSchema }))
    .max(50),
});
export type SdlcBaseline = z.infer<typeof sdlcBaselineSchema>;

export const sdlcProjectAuditSchema = z.object({
  projectId: z.string().min(1).max(200),
  name: z.string().max(200),
  status: z.enum(['ok', 'missing', 'not-git']),
  scannedAt: iso,
  results: z.array(sdlcPlayResultSchema).max(32),
  baseline: sdlcBaselineSchema,
  /** The unmet play with the most dependents whose own prerequisites are already met. */
  next: sdlcPlayIdSchema.optional(),
});
export type SdlcProjectAudit = z.infer<typeof sdlcProjectAuditSchema>;

export const sdlcAuditSchema = z.object({
  baselineVersion: z.number().int().nonnegative(),
  plays: z.array(sdlcPlaySchema).max(32),
  projects: z.array(sdlcProjectAuditSchema).max(500),
});
export type SdlcAudit = z.infer<typeof sdlcAuditSchema>;

export const sdlcBaselineRequestSchema = z.object({
  projectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
});
export type SdlcBaselineRequest = z.infer<typeof sdlcBaselineRequestSchema>;

export const sdlcBaselineActionSchema = z.enum(['create', 'update', 'skip-diverged', 'skip-current']);
export type SdlcBaselineAction = z.infer<typeof sdlcBaselineActionSchema>;

export const sdlcBaselinePlanSchema = z.object({
  projects: z
    .array(
      z.object({
        projectId: z.string().min(1).max(200),
        files: z
          .array(z.object({ path: z.string().max(300), action: sdlcBaselineActionSchema }))
          .max(50),
      }),
    )
    .max(50),
});
export type SdlcBaselinePlan = z.infer<typeof sdlcBaselinePlanSchema>;

export const sdlcBaselineApplySchema = z.object({
  runs: z
    .array(
      z.union([
        z.object({ projectId: z.string().min(1).max(200), runId: z.string().min(1).max(100) }),
        z.object({ projectId: z.string().min(1).max(200), error: z.string().max(300) }),
      ]),
    )
    .max(50),
});
export type SdlcBaselineApply = z.infer<typeof sdlcBaselineApplySchema>;
