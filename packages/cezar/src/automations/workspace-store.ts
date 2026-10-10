import { join } from 'node:path';
import {
  workspaceScheduleAutomationSchema,
  type WorkspaceScheduleAutomation,
} from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import type { AutomationDefinition } from './types.ts';
import { AutomationStore } from './store.ts';

type Editable = Omit<WorkspaceScheduleAutomation, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'workspaceRuntimeRevision'>;

/** One canonical definition file in the user's cezar home; runtime stays in each target repo. */
export function openWorkspaceAutomationStore(): AutomationStore {
  return AutomationStore.open(join(cezarHomeDir(), 'workspace-automations'), {
    rejectInvalidDefinitions: true,
    validateDefinition: value => workspaceScheduleAutomationSchema.safeParse(value).success,
  });
}

export function listWorkspaceAutomations(store: AutomationStore): WorkspaceScheduleAutomation[] {
  return store.list().flatMap(definition => {
    const parsed = workspaceScheduleAutomationSchema.safeParse(definition);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createWorkspaceAutomation(store: AutomationStore, input: Editable): WorkspaceScheduleAutomation {
  return workspaceScheduleAutomationSchema.parse(
    store.create({ ...input, workspaceRuntimeRevision: 0 } as Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>),
  );
}

export function updateWorkspaceAutomation(
  store: AutomationStore,
  id: string,
  expectedRevision: number,
  input: Editable,
  resetRuntime = false,
): WorkspaceScheduleAutomation {
  const current = store.get(id);
  if (!current) throw new Error('not found');
  const parsed = workspaceScheduleAutomationSchema.parse(current);
  return workspaceScheduleAutomationSchema.parse(
    store.update(id, expectedRevision, {
      ...input,
      workspaceRuntimeRevision: parsed.workspaceRuntimeRevision + Number(resetRuntime),
    } as Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>),
  );
}
