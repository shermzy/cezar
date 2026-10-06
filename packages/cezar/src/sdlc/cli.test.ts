import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Baseline } from './baseline.ts';
import { runSdlcCommand } from './cli.ts';

const made: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cez-sdlc-cli-'));
  made.push(d);
  return d;
};
afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

const tiny: Baseline = { version: 3, source: 'built-in', files: [{ path: 'A.md', content: 'alpha {{test}}' }] };

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  return runSdlcCommand(argv, { log: (l) => out.push(l), error: (l) => err.push(l), loadBaseline: async () => tiny }).then((code) => ({ code, out, err }));
}

describe('cez sdlc baseline', () => {
  it('apply writes the files, says what it did, and flags an unfilled placeholder', async () => {
    const root = dir();
    const r = await run(['baseline', 'apply', '--into', root]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, 'A.md'), 'utf8')).toBe('alpha {{test}}');
    expect(r.out.join('\n')).toContain('wrote   A.md');
    expect(r.out.join('\n')).toMatch(/NOTE A\.md.*placeholder/);
  });

  it('a second apply writes nothing and says the repo is current', async () => {
    const root = dir();
    await run(['baseline', 'apply', '--into', root]);
    const r = await run(['baseline', 'apply', '--into', root]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('nothing to write');
  });

  it('plan reports the action and writes nothing', async () => {
    const root = dir();
    const r = await run(['baseline', 'plan', '--into', root]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['create        A.md']);
    expect(existsSync(join(root, 'A.md'))).toBe(false);
  });

  it('fails with exit 1 when --into is not a directory', async () => {
    const r = await run(['baseline', 'apply', '--into', join(tmpdir(), 'cez-sdlc-cli-nope-xyz')]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('not a directory');
  });

  it.each([[[]], [['baseline']], [['baseline', 'wipe']], [['audit', 'apply']], [['baseline', 'apply', 'extra']], [['--bogus']]])(
    'exits 2 with usage for %j',
    async (argv) => {
      const r = await run(argv as string[]);
      expect(r.code).toBe(2);
      expect(r.err.join('\n')).toContain('cez sdlc');
    },
  );

  it('--help exits 0', async () => {
    expect((await run(['--help'])).code).toBe(0);
  });
});
