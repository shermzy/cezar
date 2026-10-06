import { describe, expect, it } from 'vitest';
import { runAgentFields } from './run-agent.ts';
import type { StepState } from './store.ts';

/**
 * Failure modes of the agent fields the slim cross-project rows carry (spec
 * `.ai/specs/2026-10-04-kanban-board.md` § Phase 1c → Which agent on which issue): `runner`,
 * `model` and `accountId` on `GET /workspace/runs-index` (and the dashboard's task rows, which
 * share the schema). Written before `run-agent.ts`. The rows carry no `steps[]`, so this is the
 * only place the account a task RAN on can be read for them.
 */

const step = (over: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...over,
});

describe('runAgentFields', () => {
  it('the account the LAST step recorded wins over the task’s own pick — that is what ran', () => {
    expect(
      runAgentFields({ agentProfile: 'default', steps: [step({ profileId: 'work' }), step({ profileId: 'other' })] }).accountId,
    ).toBe('other');
  });

  it('a later step that recorded nothing does not erase the account an earlier one ran on', () => {
    expect(runAgentFields({ steps: [step({ profileId: 'work' }), step()] }).accountId).toBe('work');
  });

  it('a task no step has run yet names the account it asked for', () => {
    expect(runAgentFields({ agentProfile: 'work', steps: [] }).accountId).toBe('work');
  });

  it('nothing recorded and nothing asked is NO key at all — never `undefined`, never a guessed "default"', () => {
    const fields = runAgentFields({ steps: [step()] });
    expect(Object.keys(fields)).toEqual([]);
  });

  it('the runner is the task’s own, else the one its last step ran on', () => {
    expect(runAgentFields({ runner: 'codex', steps: [step({ backend: 'claude' })] }).runner).toBe('codex');
    expect(runAgentFields({ steps: [step({ backend: 'claude' }), step({ backend: 'codex' })] }).runner).toBe('codex');
  });

  it('carries the model verbatim, and only when the task named one', () => {
    expect(runAgentFields({ model: 'opus', steps: [] })).toEqual({ model: 'opus' });
    expect(runAgentFields({ steps: [] })).not.toHaveProperty('model');
  });
});
