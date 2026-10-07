import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import {
  specialistCreateSchema,
  specialistDefinitionSchema,
  specialistIdSchema,
  specialistSnapshotSchema,
  specialistUpdateSchema,
  type SpecialistCreate,
  type SpecialistDefinition,
  type SpecialistSnapshot,
  type SpecialistUpdate,
} from '@open-mercato/cezar-contract';
import { specialistsPath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

const builtIns: SpecialistDefinition[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: 'Breaks a request into a clear, reviewable sequence of work.',
    instructions: 'Analyze the request and this project. Return a concise plan, risks, and acceptance checks. Do not implement unless the user explicitly asked you to implement.',
    builtIn: true,
  },
  {
    id: 'implementer',
    name: 'Implementer',
    description: 'Makes a scoped change and reports what was verified.',
    instructions: 'Implement the requested change in this project. Keep edits within scope, preserve unrelated work, and report the files changed and the checks actually run.',
    builtIn: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Looks for correctness gaps, regressions, and missing evidence.',
    instructions: 'Review the requested work for correctness and regressions. Report actionable findings first with file and line evidence. Do not modify code unless explicitly asked.',
    builtIn: true,
  },
];

const storedSpecialistSchema = specialistDefinitionSchema.extend({ builtIn: z.literal(false) });
const storeSchema = z.object({
  version: z.number().int().min(1).catch(1),
  specialists: z.array(z.unknown()).catch([]).transform((entries) => {
    const seen = new Set<string>();
    return entries.flatMap((entry) => {
      const parsed = storedSpecialistSchema.safeParse(entry);
      if (!parsed.success || seen.has(parsed.data.id) || builtIns.some((role) => role.id === parsed.data.id)) return [];
      seen.add(parsed.data.id);
      return [parsed.data];
    });
  }),
}).passthrough();

let warned = false;
function warnOnce(path: string, detail: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[cez] workspace specialists ${path} ${detail} — built-in roles remain available`);
}

type ReadResult = { specialists: SpecialistDefinition[]; writable: boolean };
function readCustomSpecialists(): ReadResult {
  const path = specialistsPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { specialists: [], writable: true };
    warnOnce(path, 'could not be read');
    return { specialists: [], writable: false };
  }

  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { specialists: parsed.data.specialists, writable: true };
  } catch {
    // Preserve the unreadable file for manual repair; built-ins still work.
  }
  warnOnce(path, 'is corrupt');
  return { specialists: [], writable: false };
}

function writeCustomSpecialists(specialists: SpecialistDefinition[]): void {
  const path = specialistsPath();
  try {
    atomicWriteJsonSync(path, { version: 1, specialists });
  } catch (error) {
    warnOnce(path, 'could not be written');
    throw new SpecialistStoreError('unavailable', 'workspace specialist storage is unavailable');
  }
}

export class SpecialistStoreError extends Error {
  constructor(readonly code: 'unavailable' | 'not-found' | 'built-in' | 'full', message: string) {
    super(message);
  }
}

export function listSpecialists(): SpecialistDefinition[] {
  return [...builtIns, ...readCustomSpecialists().specialists];
}

export function resolveSpecialist(id: string): SpecialistSnapshot | undefined {
  const role = listSpecialists().find((entry) => entry.id === id);
  if (!role) return undefined;
  return specialistSnapshotSchema.parse({ id: role.id, name: role.name, instructions: role.instructions });
}

export function createSpecialist(input: SpecialistCreate): SpecialistDefinition {
  const parsed = specialistCreateSchema.parse(input);
  const current = readCustomSpecialists();
  if (!current.writable) throw new SpecialistStoreError('unavailable', 'workspace specialist storage is unavailable');
  if (current.specialists.length >= 32) throw new SpecialistStoreError('full', 'workspace specialist limit reached (32)');
  const role = specialistDefinitionSchema.parse({
    id: `custom-${randomUUID()}`,
    ...parsed,
    builtIn: false,
  });
  writeCustomSpecialists([...current.specialists, role]);
  return role;
}

export function updateSpecialist(id: string, input: SpecialistUpdate): SpecialistDefinition {
  const roleId = specialistIdSchema.parse(id);
  const patch = specialistUpdateSchema.parse(input);
  const current = readCustomSpecialists();
  if (!current.writable) throw new SpecialistStoreError('unavailable', 'workspace specialist storage is unavailable');
  const index = current.specialists.findIndex((entry) => entry.id === roleId);
  if (index < 0) {
    if (builtIns.some((entry) => entry.id === roleId)) throw new SpecialistStoreError('built-in', 'built-in specialist roles cannot be edited');
    throw new SpecialistStoreError('not-found', 'specialist not found');
  }
  const updated = specialistDefinitionSchema.parse({ ...current.specialists[index], ...patch, builtIn: false });
  const specialists = [...current.specialists];
  specialists[index] = updated;
  writeCustomSpecialists(specialists);
  return updated;
}

export function deleteSpecialist(id: string): void {
  const roleId = specialistIdSchema.parse(id);
  const current = readCustomSpecialists();
  if (!current.writable) throw new SpecialistStoreError('unavailable', 'workspace specialist storage is unavailable');
  if (builtIns.some((entry) => entry.id === roleId)) throw new SpecialistStoreError('built-in', 'built-in specialist roles cannot be deleted');
  const specialists = current.specialists.filter((entry) => entry.id !== roleId);
  if (specialists.length === current.specialists.length) throw new SpecialistStoreError('not-found', 'specialist not found');
  writeCustomSpecialists(specialists);
}
