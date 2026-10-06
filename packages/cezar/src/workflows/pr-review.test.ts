import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAllowedTools } from '../core/claude-cli-runner.ts';
import { loadWorkflows } from './load.ts';
import { PR_REVIEW_WORKFLOW } from './types.ts';

/**
 * The reviewer is the second half of "the author cannot approve its own work" (spec
 * 2026-10-06-ai-native-sdlc-review-loop). These tests pin the properties that make it a reviewer
 * and not a second author: what it may run, what it can never run, and that it always exists.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const repo = (workflowFiles: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cez-prreview-'));
  dirs.push(root);
  for (const [name, body] of Object.entries(workflowFiles)) {
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/workflows', name), body);
  }
  return root;
};

const step = PR_REVIEW_WORKFLOW.steps[0];

describe('pr-review workflow definition', () => {
  it('is one agent step, so there is nothing to retry or chain around the review', () => {
    expect(PR_REVIEW_WORKFLOW.name).toBe('pr-review');
    expect(PR_REVIEW_WORKFLOW.source).toBe('built-in');
    expect(PR_REVIEW_WORKFLOW.steps).toHaveLength(1);
    expect(step?.prompt).toBeTruthy();
    expect(step?.command).toBeUndefined();
  });

  it('can read and search but is never given a tool that writes files', () => {
    expect(step?.allowedTools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash']));
    for (const writer of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(step?.allowedTools).not.toContain(writer);
  });

  it('restricts Bash to PR reads, one comment and read-only git, in the exact form the Claude runner receives', () => {
    const rendered = buildAllowedTools(step?.allowedTools ?? [], step?.bashAllowlist);
    for (const ok of ['Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr comment:*)', 'Bash(git diff:*)', 'Bash(git log:*)']) {
      expect(rendered).toContain(ok);
    }
    // Bare `Bash` would re-open the whole shell; the allowlist must replace it.
    expect(rendered).not.toContain('Bash');
  });

  it.each([
    'gh pr merge',
    'gh pr review',
    'gh pr close',
    'gh pr edit',
    'gh pr create',
    'gh api',
    'git push',
    'git commit',
    'git checkout',
    'rm',
  ])('never allows %s: a reviewer cannot approve, merge, push or edit', (forbidden) => {
    const allowed = step?.bashAllowlist ?? [];
    expect(allowed.some((prefix) => forbidden === prefix || forbidden.startsWith(`${prefix} `))).toBe(false);
  });

  it('tells the agent the same rules in words, for backends that do not honour an allowlist', () => {
    const prompt = step?.prompt ?? '';
    expect(prompt).toContain('{{task}}');
    expect(prompt).toContain('REVIEW.md');
    expect(prompt).toMatch(/Important/);
    expect(prompt).toMatch(/Nit/);
    expect(prompt).toMatch(/never approve/i);
    expect(prompt).toMatch(/gh pr comment/);
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/path:line/);
  });
});

describe('pr-review in the catalog', () => {
  it('exists in a repo with no workflow files, next to the other built-ins', async () => {
    const { workflows } = await loadWorkflows(repo());
    expect(workflows.map((w) => w.name)).toEqual(expect.arrayContaining(['pr-review', 'quick-task', 'sdlc-baseline']));
    expect(workflows.find((w) => w.name === 'pr-review')?.source).toBe('built-in');
  });

  it('is shadowed by a repo workflow of the same name, like every built-in', async () => {
    const yaml = 'name: pr-review\ndescription: house review\nsteps:\n  - id: r\n    prompt: "{{task}}"\n';
    const { workflows } = await loadWorkflows(repo({ 'pr-review.yaml': yaml }));
    const matches = workflows.filter((w) => w.name === 'pr-review');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe('file');
  });
});
