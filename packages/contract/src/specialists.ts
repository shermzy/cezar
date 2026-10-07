import { z } from 'zod';

export const specialistIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);

export const specialistSnapshotSchema = z.object({
  id: specialistIdSchema,
  name: z.string().min(1).max(80),
  instructions: z.string().min(1).max(8_000),
});
export type SpecialistSnapshot = z.infer<typeof specialistSnapshotSchema>;

export const specialistDefinitionSchema = specialistSnapshotSchema.extend({
  description: z.string().max(400),
  builtIn: z.boolean(),
});
export type SpecialistDefinition = z.infer<typeof specialistDefinitionSchema>;

export const specialistCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(''),
  instructions: z.string().trim().min(1).max(8_000),
});
export type SpecialistCreate = z.infer<typeof specialistCreateSchema>;

export const specialistUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(400).optional(),
    instructions: z.string().trim().min(1).max(8_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'provide at least one field to update');
export type SpecialistUpdate = z.infer<typeof specialistUpdateSchema>;

export const specialistIdParamSchema = z.object({ id: specialistIdSchema });
export const specialistsResponseSchema = z.object({ specialists: z.array(specialistDefinitionSchema) });
export const specialistResponseSchema = z.object({ specialist: specialistDefinitionSchema });
export const specialistMutationResponseSchema = z.object({ ok: z.literal(true) });
export type SpecialistsResponse = z.infer<typeof specialistsResponseSchema>;
export type SpecialistResponse = z.infer<typeof specialistResponseSchema>;
export type SpecialistMutationResponse = z.infer<typeof specialistMutationResponseSchema>;

export const specialistRunIdentitySchema = specialistSnapshotSchema.pick({ id: true, name: true });
export type SpecialistRunIdentity = z.infer<typeof specialistRunIdentitySchema>;
