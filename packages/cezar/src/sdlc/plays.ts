import type { SdlcPlay, SdlcPlayId, SdlcPlayResult } from '@open-mercato/cezar-contract';

/**
 * The plays of the AI-native SDLC playbook that can be told from files alone (spec
 * 2026-10-06-ai-native-sdlc-fleet § Play catalog). Auto mode and on-call are deliberately absent:
 * nothing in a repo's tree says whether either is in use.
 *
 * Catalog order is the tie-break for `nextMove`, so keep prerequisites ahead of their dependents.
 */
export const PLAYS: readonly SdlcPlay[] = [
  { id: 'intent', stage: 'plan', title: 'Capture as intent.md', prereqs: [] },
  { id: 'spec', stage: 'design', title: 'Requirements and design in one spec', prereqs: ['intent'] },
  { id: 'plan', stage: 'build', title: 'Plan before building', prereqs: ['claude-md'] },
  { id: 'claude-md', stage: 'build', title: 'CLAUDE.md', prereqs: [] },
  { id: 'skills', stage: 'build', title: 'Skills as institutional knowledge', prereqs: [] },
  { id: 'build-hooks', stage: 'build', title: 'Hooks as build-time guardrails', prereqs: ['skills'] },
  { id: 'subagents', stage: 'build', title: 'Subagents', prereqs: ['claude-md'] },
  { id: 'feedback-loop', stage: 'test', title: 'Self-verifying feedback loop', prereqs: [] },
  { id: 'config-evals', stage: 'test', title: 'Continuous evals on agent config', prereqs: ['claude-md', 'feedback-loop'] },
  { id: 'agent-review', stage: 'deploy', title: 'AI in the PR review loop', prereqs: ['claude-md'] },
  { id: 'approval-gates', stage: 'deploy', title: 'Hooks as approval gates', prereqs: [] },
  { id: 'ci-agent-jobs', stage: 'deploy', title: 'Agent jobs in CI', prereqs: ['agent-review', 'approval-gates'] },
  { id: 'close-the-loop', stage: 'maintain', title: 'Close the loop from monitoring', prereqs: ['intent', 'agent-review', 'approval-gates'] },
  { id: 'recurring-scans', stage: 'maintain', title: 'Recurring codebase scans', prereqs: ['intent', 'agent-review', 'approval-gates'] },
];

/**
 * The unmet play to work on next: one whose prerequisites are all Present, ranked by how many
 * other plays wait on it (so foundations come first), catalog order breaking ties. Undefined when
 * every play is Present.
 */
export function nextMove(results: ReadonlyArray<Pick<SdlcPlayResult, 'play' | 'score'>>): SdlcPlayId | undefined {
  const score = new Map(results.map((r) => [r.play, r.score]));
  const dependents = (id: SdlcPlayId) => PLAYS.filter((p) => p.prereqs.includes(id)).length;
  const candidates = PLAYS.filter(
    (p) => score.get(p.id) !== 'present' && p.prereqs.every((q) => score.get(q) === 'present'),
  );
  let best: SdlcPlay | undefined;
  for (const p of candidates) {
    if (!best || dependents(p.id) > dependents(best.id)) best = p;
  }
  return best?.id;
}
