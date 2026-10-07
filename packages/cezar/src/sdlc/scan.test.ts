import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SdlcPlayId, SdlcScore } from '@open-mercato/cezar-contract';
import { PLAYS, nextMove } from './plays.ts';
import { scanProject } from './scan.ts';

const made: string[] = [];

/** A throwaway git-looking repo holding exactly `files`. */
function repo(files: Record<string, string> = {}, opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-sdlc-'));
  made.push(root);
  if (opts.git !== false) mkdirSync(join(root, '.git'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

async function scores(root: string): Promise<Partial<Record<SdlcPlayId, SdlcScore>>> {
  const { results } = await scanProject(root);
  return Object.fromEntries(results.map((r) => [r.play, r.score]));
}

const lines = (n: number, text = 'line') => Array.from({ length: n }, (_, i) => `${text} ${i}`).join('\n');
const settings = (hooks: Record<string, unknown>) => JSON.stringify({ hooks });
const hook = (matcher: string, command: string) => [{ matcher, hooks: [{ type: 'command', command }] }];

describe('scanProject: degraded inputs never throw', () => {
  it('reports a root that no longer exists as missing, with no results', async () => {
    const out = await scanProject(join(tmpdir(), 'cez-sdlc-does-not-exist-xyz'));
    expect(out.status).toBe('missing');
    expect(out.results).toEqual([]);
  });

  it('reports a folder without .git as not-git', async () => {
    const out = await scanProject(repo({ 'CLAUDE.md': 'x' }, { git: false }));
    expect(out.status).toBe('not-git');
    expect(out.results).toEqual([]);
  });

  it('scores a bare repo Absent on every play', async () => {
    const out = await scanProject(repo());
    expect(out.status).toBe('ok');
    expect(out.results.map((r) => r.play).sort()).toEqual(PLAYS.map((p) => p.id).sort());
    expect(out.results.every((r) => r.score === 'absent' && r.evidence.length === 0)).toBe(true);
  });

  it('survives malformed settings.json, package.json and workflow files', async () => {
    const s = await scores(
      repo({
        '.claude/settings.json': '{ not json',
        'package.json': '{{{',
        '.github/workflows/ci.yml': '\u0000\u0001: [unterminated',
      }),
    );
    expect(s['build-hooks']).toBe('absent');
    expect(s['feedback-loop']).toBe('absent');
    expect(s['agent-review']).toBe('absent');
  });

  it('caps the read of an enormous CLAUDE.md and still answers', async () => {
    const root = repo({ 'CLAUDE.md': lines(200_000, 'x'.repeat(40)) });
    const out = await scanProject(root);
    const claude = out.results.find((r) => r.play === 'claude-md');
    expect(claude?.score).toBe('partial');
    expect(claude?.note).toMatch(/lines|long/i);
  });

  it('does not follow a symlink that leaves the repo', async () => {
    const outside = repo({ 'secret-claude.md': 'run npm test' }, { git: false });
    const root = repo();
    try {
      symlinkSync(join(outside, 'secret-claude.md'), join(root, 'CLAUDE.md'));
    } catch {
      return; // symlinks need privilege on some Windows setups; the guard is exercised elsewhere
    }
    expect((await scores(root))['claude-md']).toBe('absent');
  });
});

describe('scanProject: plays', () => {
  it('CLAUDE.md: short with a verify command is Present, long is Partial, AGENTS.md alone is Partial', async () => {
    expect((await scores(repo({ 'CLAUDE.md': `Run npm test before done.\n${lines(20)}` })))['claude-md']).toBe('present');
    const long = await scanProject(repo({ 'CLAUDE.md': `npm test\n${lines(212)}` }));
    expect(long.results.find((r) => r.play === 'claude-md')).toMatchObject({ score: 'partial' });
    expect(long.results.find((r) => r.play === 'claude-md')?.note).toContain('213');
    expect((await scores(repo({ 'AGENTS.md': 'npm test' })))['claude-md']).toBe('partial');
    expect((await scores(repo({ 'CLAUDE.md': lines(10) })))['claude-md']).toBe('partial'); // no verify command
  });

  it('intent: a stated-status file is Present, a template alone is Partial', async () => {
    expect((await scores(repo({ 'intent/2026-10-01-x.md': 'Status: accepted\n# x' })))['intent']).toBe('present');
    expect((await scores(repo({ 'intent/TEMPLATE.md': '# template' })))['intent']).toBe('partial');
    expect((await scores(repo({ '.ai/intent/a.md': 'status: proposed' })))['intent']).toBe('present');
  });

  it('spec: Present beside an intent, Partial without one, regardless of policy skills', async () => {
    const intent = { 'intent/a.md': 'status: accepted' };
    expect((await scores(repo({ ...intent, '.ai/specs/a.md': '# spec' })))['spec']).toBe('present');
    expect((await scores(repo({ ...intent, 'spec.md': '# spec' })))['spec']).toBe('present');
    expect((await scores(repo({ '.ai/specs/a.md': '# spec' })))['spec']).toBe('partial');
    expect((await scores(repo(intent)))['spec']).toBe('absent');
  });

  it('plan: a plan file is Present; a plan-mode hint in CLAUDE.md is Partial', async () => {
    expect((await scores(repo({ '.ai/plans/a.md': '# plan' })))['plan']).toBe('present');
    expect((await scores(repo({ 'plan.md': '# plan' })))['plan']).toBe('present');
    expect((await scores(repo({ 'CLAUDE.md': 'Always use plan mode first.' })))['plan']).toBe('partial');
  });

  it('skills: two skills Present, one Partial', async () => {
    const skill = (n: string) => ({ [`.claude/skills/${n}/SKILL.md`]: '---\nname: x\n---' });
    expect((await scores(repo({ ...skill('a'), ...skill('b') })))['skills']).toBe('present');
    expect((await scores(repo(skill('a'))))['skills']).toBe('partial');
    expect((await scores(repo({ '.ai/skills/a/SKILL.md': 'x', '.ai/skills/b/SKILL.md': 'x' })))['skills']).toBe('present');
  });

  it('build-hooks: PreToolUse and PostToolUse together are Present, one of them Partial', async () => {
    const both = settings({ PreToolUse: hook('Bash', 'node a.mjs'), PostToolUse: hook('Edit', 'node b.mjs') });
    expect((await scores(repo({ '.claude/settings.json': both })))['build-hooks']).toBe('present');
    const pre = settings({ PreToolUse: hook('Bash', 'node a.mjs') });
    expect((await scores(repo({ '.claude/settings.json': pre })))['build-hooks']).toBe('partial');
  });

  it('subagents: any .claude/agents/*.md is Present', async () => {
    expect((await scores(repo({ '.claude/agents/verifier.md': '---\nname: v\n---' })))['subagents']).toBe('present');
    expect((await scores(repo({ '.claude/agents/notes.txt': 'x' })))['subagents']).toBe('absent');
  });

  it('feedback-loop: test + lint scripts and a CLAUDE.md verify line is Present, scripts alone Partial', async () => {
    const pkg = JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc' } });
    expect((await scores(repo({ 'package.json': pkg, 'CLAUDE.md': 'Verify: npm test' })))['feedback-loop']).toBe('present');
    expect((await scores(repo({ 'package.json': pkg })))['feedback-loop']).toBe('partial');
    expect((await scores(repo({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }) })))['feedback-loop']).toBe('absent');
  });

  it('config-evals: evals plus a workflow triggered by CLAUDE.md/.claude paths is Present', async () => {
    const wf = 'on:\n  pull_request:\n    paths:\n      - "CLAUDE.md"\n      - ".claude/**"\njobs: {}';
    expect((await scores(repo({ 'evals/a.json': '{}', '.github/workflows/evals.yml': wf })))['config-evals']).toBe('present');
    expect((await scores(repo({ 'evals/a.json': '{}' })))['config-evals']).toBe('partial');
  });

  it('agent-review: REVIEW.md plus claude-code-action is Present, REVIEW.md alone Partial', async () => {
    const wf = 'jobs:\n  r:\n    steps:\n      - uses: anthropics/claude-code-action@v1';
    expect((await scores(repo({ 'REVIEW.md': '# r', '.github/workflows/review.yml': wf })))['agent-review']).toBe('present');
    expect((await scores(repo({ 'REVIEW.md': '# r' })))['agent-review']).toBe('partial');
    expect((await scores(repo({ '.github/workflows/review.yml': wf })))['agent-review']).toBe('partial');
  });

  it('agent-review: an enabled cezar pr-review automation counts in place of a CI action; a paused or unrelated one does not', async () => {
    const auto = (enabled: boolean, workflow: string) =>
      JSON.stringify({ version: 1, automations: [{ id: 'a', name: 'Review', enabled, kind: 'github', task: { prompt: 'x', workflow } }] });
    const withAuto = (body: string) => ({ 'REVIEW.md': '# r', '.ai/cezar/automations.json': body });
    const on = await scanProject(repo(withAuto(auto(true, 'builtin:pr-review'))));
    expect(on.results.find((r) => r.play === 'agent-review')).toMatchObject({ score: 'present' });
    expect(on.results.find((r) => r.play === 'agent-review')?.evidence).toContain('.ai/cezar/automations.json');
    const paused = await scanProject(repo(withAuto(auto(false, 'builtin:pr-review'))));
    expect(paused.results.find((r) => r.play === 'agent-review')).toMatchObject({ score: 'partial' });
    expect(paused.results.find((r) => r.play === 'agent-review')?.note).toMatch(/enable|paused/i);
    expect((await scores(repo(withAuto(auto(true, 'quick-task')))))['agent-review']).toBe('partial');
    // The automation alone, without REVIEW.md, is half the play.
    expect((await scores(repo({ '.ai/cezar/automations.json': auto(true, 'builtin:pr-review') })))['agent-review']).toBe('partial');
  });

  it('agent-review: a corrupt or hostile automations.json never throws and falls back to the workflow check', async () => {
    expect((await scores(repo({ 'REVIEW.md': '# r', '.ai/cezar/automations.json': '{ nope' })))['agent-review']).toBe('partial');
    expect((await scores(repo({ 'REVIEW.md': '# r', '.ai/cezar/automations.json': JSON.stringify({ automations: 'x' }) })))['agent-review']).toBe('partial');
    expect((await scores(repo({ 'REVIEW.md': '# r', '.ai/cezar/automations.json': JSON.stringify({ automations: [null, 3, { task: null }] }) })))['agent-review']).toBe('partial');
    const wf = 'jobs:\n  r:\n    steps:\n      - uses: anthropics/claude-code-action@v1';
    expect((await scores(repo({ 'REVIEW.md': '# r', '.ai/cezar/automations.json': '{ nope', '.github/workflows/review.yml': wf })))['agent-review']).toBe('present');
  });

  it('approval-gates: a Bash hook that blocks merge or approve counts as a gate', async () => {
    const guard = settings({ PreToolUse: hook('Bash', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-merge.mjs"') });
    expect((await scores(repo({ '.claude/settings.json': guard })))['approval-gates']).toBe('present');
    const approve = settings({ PreToolUse: hook('Bash(gh pr review*)', 'node block-approve.mjs') });
    expect((await scores(repo({ '.claude/settings.json': approve })))['approval-gates']).toBe('present');
  });

  it('approval-gates: a PreToolUse hook on a push/deploy/secret pattern is Present, other hooks Partial', async () => {
    const gate = settings({ PreToolUse: hook('Bash(git push*)', 'node block-push.mjs') });
    expect((await scores(repo({ '.claude/settings.json': gate })))['approval-gates']).toBe('present');
    const other = settings({ PostToolUse: hook('Edit', 'node fmt.mjs') });
    expect((await scores(repo({ '.claude/settings.json': other })))['approval-gates']).toBe('partial');
    expect((await scores(repo()))['approval-gates']).toBe('absent');
  });

  it('ci-agent-jobs: claude -p in a workflow is Present', async () => {
    const wf = 'jobs:\n  t:\n    steps:\n      - run: claude -p "triage the failure"';
    expect((await scores(repo({ '.github/workflows/triage.yml': wf })))['ci-agent-jobs']).toBe('present');
  });

  it('close-the-loop: bands file plus a scheduled workflow is Present, the file alone Partial', async () => {
    const wf = 'on:\n  schedule:\n    - cron: "0 * * * *"\njobs:\n  d:\n    steps:\n      - run: node detect.mjs bands.yaml';
    expect((await scores(repo({ 'bands.yaml': 'metric: x', '.github/workflows/detect.yml': wf })))['close-the-loop']).toBe('present');
    expect((await scores(repo({ 'bands.yaml': 'metric: x' })))['close-the-loop']).toBe('partial');
  });

  it('recurring-scans: a scheduled security scan is Present, scan-on-push Partial', async () => {
    const sched = 'on:\n  schedule:\n    - cron: "0 3 * * 1"\njobs:\n  s:\n    steps:\n      - uses: github/codeql-action/analyze@v3';
    const push = 'on:\n  push:\njobs:\n  s:\n    steps:\n      - uses: github/codeql-action/analyze@v3';
    expect((await scores(repo({ '.github/workflows/codeql.yml': sched })))['recurring-scans']).toBe('present');
    expect((await scores(repo({ '.github/workflows/codeql.yml': push })))['recurring-scans']).toBe('partial');
  });

  it('caps evidence at five paths and keeps it repo-relative', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`.claude/agents/a${i}.md`] = 'x';
    const out = await scanProject(repo(files));
    const sub = out.results.find((r) => r.play === 'subagents');
    expect(sub?.evidence).toHaveLength(5);
    expect(sub?.evidence.every((p) => !p.includes('\\') && !p.startsWith('/') && !/^[a-z]:/i.test(p))).toBe(true);
  });

  it('is deterministic: the same repo scores identically twice', async () => {
    const root = repo({ 'CLAUDE.md': 'npm test', '.claude/agents/a.md': 'x' });
    expect(await scanProject(root)).toEqual(await scanProject(root));
  });
});

describe('nextMove', () => {
  const all = (score: SdlcScore) => PLAYS.map((p) => ({ play: p.id, score, evidence: [] as string[] }));

  it('points a bare repo at CLAUDE.md, the unmet play with the most dependents', () => {
    expect(nextMove(all('absent'))).toBe('claude-md');
  });

  it('never suggests a play whose prerequisites are unmet', () => {
    const results = all('absent');
    const next = nextMove(results);
    const def = PLAYS.find((p) => p.id === next);
    expect(def?.prereqs.every((q) => results.find((r) => r.play === q)?.score === 'present')).toBe(true);
  });

  it('advances once the foundation exists', () => {
    const results = all('absent').map((r) => (r.play === 'claude-md' ? { ...r, score: 'present' as const } : r));
    expect(nextMove(results)).not.toBe('claude-md');
  });

  it('returns undefined when every play is Present', () => {
    expect(nextMove(all('present'))).toBeUndefined();
  });
});
