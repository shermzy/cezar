import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBaseline } from './baseline.ts';

/**
 * The best-effort merge/approve guard shipped in the SDLC baseline
 * (spec 2026-10-06-ai-native-sdlc-review-loop), run as the child process Claude Code would start.
 * These cases cover common direct and nested GitHub CLI calls and harmless quoted mentions;
 * GitHub-side permissions remain the enforcement boundary.
 */
const baselineDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'baseline');
const script = join(baselineDir, 'files', 'claude', 'hooks', 'guard-merge.mjs');
const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

function run(stdin: string) {
  const home = mkdtempSync(join(tmpdir(), 'cez-guard-merge-'));
  made.push(home);
  return spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: home } });
}
const bash = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });

describe('guard-merge blocks covered merge and approve commands', () => {
  it.each([
    'gh pr merge 12 --squash',
    'gh pr merge',
    'gh -R owner/repo pr merge 3',
    'gh --repo owner/repo pr merge 3 --admin',
    'cd packages/api && gh pr merge 9',
    'FOO=1 gh pr merge 9',
    'sudo gh pr merge 9',
    'echo done | gh pr merge 9',
    'git push && gh pr merge --auto --squash',
    'gh pr review 5 --approve',
    'gh pr review 5 -a -b "looks good"',
    'gh pr review --approve --body ok 5',
    'gh api -X PUT repos/o/r/pulls/5/merge',
    'gh api --method PUT /repos/o/r/pulls/12/merge -f merge_method=squash',
    'gh api repos/o/r/pulls/5/reviews -f event=APPROVE',
    'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { addPullRequestReview(input: {pullRequestId: "x", event: APPROVE}) { clientMutationId } }\'',
    "bash -c 'gh pr merge 5'",
    'env -i gh pr merge 5',
    'gh pr comment 5 --body "$(gh pr merge 5)"',
    'gh.exe pr merge 5',
    'echo `gh pr merge 5`',
    'echo "`gh pr merge 5`"',
    'cmd /c gh.exe pr merge 5',
    'pwsh -Command "gh.exe pr merge 5"',
    "pwsh -Com 'gh pr merge 5'",
    "pwsh -CommandWithArgs 'gh pr merge 5'",
    "pwsh -cwa 'gh pr merge 5'",
    "env -S 'gh pr merge 5'",
    "env --split-string='gh pr merge 5'",
    '/usr/bin/env gh pr merge 5',
    'nice -n 0 gh pr merge 5',
    'sudo -u root gh pr merge 5',
    'time -p gh pr merge 5',
    'pwsh -EncodedCommand opaque',
    'powershell.exe -enc opaque',
  ])('blocks: %s', (command) => {
    const r = run(bash(command));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('guard-merge');
    expect(r.stderr).toMatch(/human/i);
  });
});

describe('guard-merge fails closed when a wrapper command is opaque', () => {
  it.each([
    'env --unknown gh pr view 5',
    'nice --unknown gh pr view 5',
    'sudo --unknown gh pr view 5',
  ])('blocks unsupported wrapper options: %s', (command) => {
    expect(run(bash(command)).status).toBe(2);
  });
});

describe('guard-merge allows covered non-merge commands', () => {
  it.each([
    'gh pr view 5',
    'gh pr diff 5',
    'gh pr checks 5',
    'gh pr create --draft --title x --body y',
    'gh pr comment 5 --body "needs a rebase"',
    'gh pr review 5 --comment --body "one question"',
    'gh pr review 5 --request-changes --body "no"',
    'gh api repos/o/r/pulls/5/comments',
    'gh api repos/o/r/pulls/5/reviews',
    'git push origin feature',
    'git commit -m "docs: explain how gh pr merge works"',
    'git commit -m "never run gh pr review --approve from an agent"',
    'gh pr comment 5 --body "Do not gh pr merge --admin; wait for the human."',
    'echo "gh pr merge 5"',
    "echo '`gh pr merge 5`'",
    "echo 'env -S gh pr merge 5'",
    'git commit -m "mention pwsh -EncodedCommand without running it"',
    '/usr/bin/env gh pr view 5',
    'nice -n 0 gh pr view 5',
    "pwsh -Com 'gh pr view 5'",
    'ls -la',
    'npm test',
  ])('allows: %s', (command) => {
    expect(run(bash(command)).status).toBe(0);
  });

  it('ignores tools other than Bash', () => {
    expect(run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/x/a.md', content: 'gh pr merge 5' } })).status).toBe(0);
  });

  it('fails open on unreadable input or a missing command, so a broken event never wedges a session', () => {
    expect(run('not json').status).toBe(0);
    expect(run('').status).toBe(0);
    expect(run(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).status).toBe(0);
  });
});

describe('baseline v2 wires the guard in', () => {
  it('ships guard-merge.mjs, at version 2 or later, and settings.json runs it on Bash', async () => {
    const baseline = await loadBaseline({ env: { CEZ_HOME: mkdtempSync(join(tmpdir(), 'cez-guard-home-')) }, warn: () => undefined });
    made.push();
    expect(baseline.version).toBeGreaterThanOrEqual(2);
    expect(baseline.files.map((f) => f.path)).toContain('.claude/hooks/guard-merge.mjs');
    const settings = JSON.parse(baseline.files.find((f) => f.path === '.claude/settings.json')?.content ?? '{}') as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const group = settings.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.includes('guard-merge.mjs')));
    expect(group?.matcher).toBe('Bash');
    // The secret guard still guards edits; adding a Bash guard must not displace it.
    expect(settings.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command.includes('guard-secrets.mjs')))).toBe(true);
  });

  it('keeps the guard on disk byte-identical to what the manifest lists (no drift between bundle and files)', () => {
    const manifest = JSON.parse(readFileSync(join(baselineDir, 'manifest.json'), 'utf8')) as { files: Array<{ path: string; source: string }> };
    const entry = manifest.files.find((f) => f.path === '.claude/hooks/guard-merge.mjs');
    expect(entry).toBeDefined();
    expect(readFileSync(join(baselineDir, entry?.source ?? ''), 'utf8')).toBe(readFileSync(script, 'utf8'));
  });
});
