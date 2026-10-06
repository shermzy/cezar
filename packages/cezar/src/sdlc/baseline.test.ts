import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBaseline, baselineAudit, loadBaseline, planBaseline, type Baseline } from './baseline.ts';
import { scanProject } from './scan.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-baseline-'));
  made.push(dir);
  return dir;
};
const repo = (files: Record<string, string> = {}) => {
  const root = tmp();
  mkdirSync(join(root, '.git'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const warn = () => undefined;

afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

/** A tiny two-file bundle, so version/diverged cases do not depend on the shipped content. */
function bundle(version: number, files: Record<string, string>): Baseline {
  return { version, source: 'built-in', files: Object.entries(files).map(([path, content]) => ({ path, content })) };
}

describe('loadBaseline', () => {
  it('loads the shipped baseline: versioned, non-empty, safe relative paths', async () => {
    const b = await loadBaseline({ env: { CEZ_HOME: tmp() }, warn });
    expect(b.source).toBe('built-in');
    expect(b.version).toBeGreaterThanOrEqual(1);
    const paths = b.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['CLAUDE.md', '.claude/settings.json', '.claude/hooks/guard-secrets.mjs', 'REVIEW.md', 'intent/TEMPLATE.md']));
    expect(b.files.every((f) => f.content.length > 0 && !f.path.startsWith('/') && !f.path.includes('..'))).toBe(true);
    expect(paths).not.toContain('.claude/cezar-baseline.json');
  });

  it('uses ~/.cezar/sdlc-baseline when it holds a valid bundle', async () => {
    const home = tmp();
    mkdirSync(join(home, 'sdlc-baseline'), { recursive: true });
    writeFileSync(join(home, 'sdlc-baseline', 'manifest.json'), JSON.stringify({ version: 7, files: [{ source: 'a.md', path: 'NOTES.md' }] }));
    writeFileSync(join(home, 'sdlc-baseline', 'a.md'), 'mine');
    const b = await loadBaseline({ env: { CEZ_HOME: home }, warn });
    expect(b).toMatchObject({ version: 7, source: 'override', files: [{ path: 'NOTES.md', content: 'mine' }] });
  });

  it('falls back to the built-in baseline, once, when the override is invalid', async () => {
    const home = tmp();
    mkdirSync(join(home, 'sdlc-baseline'), { recursive: true });
    writeFileSync(join(home, 'sdlc-baseline', 'manifest.json'), '{ not json');
    const warnings: string[] = [];
    const b = await loadBaseline({ env: { CEZ_HOME: home }, warn: (m) => warnings.push(m) });
    expect(b.source).toBe('built-in');
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ['a parent traversal', '../escape.md'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows drive path', 'C:/Windows/x.md'],
    ['the reserved manifest path', '.claude/cezar-baseline.json'],
  ])('rejects an override that names %s', async (_label, path) => {
    const home = tmp();
    mkdirSync(join(home, 'sdlc-baseline'), { recursive: true });
    writeFileSync(join(home, 'sdlc-baseline', 'manifest.json'), JSON.stringify({ version: 2, files: [{ source: 'a.md', path }] }));
    writeFileSync(join(home, 'sdlc-baseline', 'a.md'), 'x');
    const b = await loadBaseline({ env: { CEZ_HOME: home }, warn });
    expect(b.source).toBe('built-in');
  });
});

describe('planBaseline / applyBaseline', () => {
  it('creates every file in an empty repo and records hashes of what it wrote', async () => {
    const root = repo();
    const b = bundle(1, { 'A.md': 'alpha', 'dir/B.md': 'beta' });
    expect((await planBaseline(root, b)).map((f) => f.action)).toEqual(['create', 'create']);
    const out = await applyBaseline(root, b);
    expect(out.written.sort()).toEqual(['A.md', 'dir/B.md']);
    expect(read(root, 'dir/B.md')).toBe('beta');
    const manifest = JSON.parse(read(root, '.claude/cezar-baseline.json'));
    expect(manifest).toEqual({ version: 1, files: { 'A.md': sha('alpha'), 'dir/B.md': sha('beta') } });
  });

  it('is idempotent: a second apply plans only skip-current and changes nothing', async () => {
    const root = repo();
    const b = bundle(1, { 'A.md': 'alpha' });
    await applyBaseline(root, b);
    const before = read(root, '.claude/cezar-baseline.json');
    expect((await planBaseline(root, b)).map((f) => f.action)).toEqual(['skip-current']);
    const again = await applyBaseline(root, b);
    expect(again.written).toEqual([]);
    expect(read(root, '.claude/cezar-baseline.json')).toBe(before);
  });

  it('never modifies an existing file cezar did not write', async () => {
    const root = repo({ 'CLAUDE.md': 'my own rules' });
    const b = bundle(1, { 'CLAUDE.md': 'template', 'REVIEW.md': 'review' });
    const plan = await planBaseline(root, b);
    expect(plan).toEqual([
      { path: 'CLAUDE.md', action: 'skip-diverged' },
      { path: 'REVIEW.md', action: 'create' },
    ]);
    await applyBaseline(root, b);
    expect(read(root, 'CLAUDE.md')).toBe('my own rules');
    expect(JSON.parse(read(root, '.claude/cezar-baseline.json')).files).not.toHaveProperty('CLAUDE.md');
  });

  it('treats an identical untracked file as already current', async () => {
    const root = repo({ 'A.md': 'alpha' });
    expect((await planBaseline(root, bundle(1, { 'A.md': 'alpha' })))[0]?.action).toBe('skip-current');
  });

  it('updates a file cezar wrote and nobody edited when the baseline moves on, and leaves an edited one', async () => {
    const root = repo();
    await applyBaseline(root, bundle(1, { 'A.md': 'a1', 'B.md': 'b1' }));
    writeFileSync(join(root, 'B.md'), 'b1 edited by a person');
    const v2 = bundle(2, { 'A.md': 'a2', 'B.md': 'b2' });
    expect(await planBaseline(root, v2)).toEqual([
      { path: 'A.md', action: 'update' },
      { path: 'B.md', action: 'skip-diverged' },
    ]);
    await applyBaseline(root, v2);
    expect(read(root, 'A.md')).toBe('a2');
    expect(read(root, 'B.md')).toBe('b1 edited by a person');
    expect(JSON.parse(read(root, '.claude/cezar-baseline.json')).version).toBe(2);
  });

  it('fills {{test}} and {{lint}} from package.json and reports the ones it could not fill', async () => {
    const filled = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc' } }) });
    const b = bundle(1, { 'C.md': 'T={{test}} L={{lint}}' });
    await applyBaseline(filled, b);
    expect(read(filled, 'C.md')).toBe('T=npm test L=npm run typecheck');

    const bare = repo();
    const out = await applyBaseline(bare, b);
    expect(read(bare, 'C.md')).toBe('T={{test}} L={{lint}}');
    expect(out.unfilled).toEqual(['C.md']);
  });

  it('refuses to write outside the repository', async () => {
    const root = repo();
    const evil: Baseline = { version: 1, source: 'override', files: [{ path: '../outside.md', content: 'x' }] };
    await expect(applyBaseline(root, evil)).rejects.toThrow(/outside/i);
    expect(existsSync(join(root, '..', 'outside.md'))).toBe(false);
  });

  it('treats a corrupt manifest as no manifest rather than failing', async () => {
    const root = repo({ '.claude/cezar-baseline.json': '{ nope' });
    const b = bundle(1, { 'A.md': 'alpha' });
    expect((await planBaseline(root, b))[0]?.action).toBe('create');
    await expect(applyBaseline(root, b)).resolves.toBeDefined();
  });
});

describe('baselineAudit', () => {
  it('walks none → current → diverged → outdated', async () => {
    const root = repo();
    const v1 = bundle(1, { 'A.md': 'alpha' });
    expect((await baselineAudit(root, v1)).state).toBe('none');

    await applyBaseline(root, v1);
    expect(await baselineAudit(root, v1)).toMatchObject({ state: 'current', version: 1, files: [{ path: 'A.md', state: 'untouched' }] });

    writeFileSync(join(root, 'A.md'), 'edited');
    expect((await baselineAudit(root, v1)).state).toBe('diverged');
    writeFileSync(join(root, 'A.md'), 'alpha');

    expect((await baselineAudit(root, bundle(2, { 'A.md': 'alpha' }))).state).toBe('outdated');
  });

  it('reports a deleted baseline file as missing', async () => {
    const root = repo();
    const b = bundle(1, { 'A.md': 'alpha' });
    await applyBaseline(root, b);
    rmSync(join(root, 'A.md'));
    expect(await baselineAudit(root, b)).toMatchObject({ state: 'diverged', files: [{ path: 'A.md', state: 'missing' }] });
  });
});

describe('the shipped baseline, applied to a real repo', () => {
  it('moves the audit matrix and leaves a second apply with nothing to do', async () => {
    const root = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc' } }) });
    const b = await loadBaseline({ env: { CEZ_HOME: tmp() }, warn });
    await applyBaseline(root, b);

    const scored = Object.fromEntries((await scanProject(root)).results.map((r) => [r.play, r.score]));
    expect(scored).toMatchObject({
      'claude-md': 'present',
      'feedback-loop': 'present',
      'build-hooks': 'present',
      'approval-gates': 'present',
      'agent-review': 'partial',
      intent: 'partial',
    });
    expect((await baselineAudit(root, b)).state).toBe('current');
    expect((await planBaseline(root, b)).every((f) => f.action === 'skip-current')).toBe(true);
  });
});

describe('shipped hook scripts', () => {
  const hooks = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'baseline', 'files', 'claude', 'hooks');
  const run = (script: string, stdin: string) =>
    spawnSync(process.execPath, [join(hooks, script)], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: tmp() } });
  const edit = (file_path: string, content = 'ok') => JSON.stringify({ tool_name: 'Write', tool_input: { file_path, content } });

  it.each([
    ['a .env file', edit('/repo/.env')],
    ['a nested .env.production', edit('C:\\repo\\config\\.env.production')],
    ['a private key file', edit('/repo/deploy/key.pem')],
    ['a lockfile', edit('/repo/package-lock.json')],
    ['an AWS key in content', edit('/repo/src/a.ts', 'const k = "AKIAABCDEFGHIJKLMNOP"')],
    ['a GitHub token in an edit', JSON.stringify({ tool_input: { file_path: '/repo/a.ts', new_string: `t = "ghp_${'a'.repeat(36)}"` } })],
    ['a private key block', edit('/repo/a.txt', '-----BEGIN RSA PRIVATE KEY-----\nabc')],
  ])('guard-secrets blocks %s (exit 2, with a reason)', (_label, stdin) => {
    const r = run('guard-secrets.mjs', stdin);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('guard-secrets');
  });

  it.each([
    ['a normal source file', edit('/repo/src/a.ts', 'export const a = 1')],
    ['.env.example', edit('/repo/.env.example', 'API_KEY=')],
    ['a read-only tool event with no path', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })],
  ])('guard-secrets allows %s', (_label, stdin) => {
    expect(run('guard-secrets.mjs', stdin).status).toBe(0);
  });

  it('both hooks fail open on garbage input so a broken event can never wedge a session', () => {
    expect(run('guard-secrets.mjs', 'not json').status).toBe(0);
    expect(run('format.mjs', 'not json').status).toBe(0);
  });

  it('format exits 0 and does nothing when the repo has no Prettier', () => {
    expect(run('format.mjs', edit('/repo/src/a.ts')).status).toBe(0);
  });
});
