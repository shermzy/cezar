import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { authStoreReady, bootstrapOwner } from './auth.ts';

describe('auth store lock readiness', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-auth-lock-ready-'));
    process.env.CEZ_HOME = home;
    await bootstrapOwner('owner', 'correct-horse-battery-staple');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects a file where proper-lockfile must create its sidecar directory', () => {
    writeFileSync(join(home, 'auth.lock.lock'), 'not a lock directory');
    expect(authStoreReady()).toBe(false);
  });

  it('rejects a nonempty sidecar directory that proper-lockfile cannot remove', () => {
    const sidecar = join(home, 'auth.lock.lock');
    mkdirSync(sidecar);
    writeFileSync(join(sidecar, 'unexpected'), 'x');
    expect(authStoreReady()).toBe(false);
  });

  it('allows a valid active lock directory without trying to acquire it', async () => {
    const release = await lockfile.lock(join(home, 'auth.lock'), { realpath: false });
    try {
      expect(authStoreReady()).toBe(true);
    } finally {
      await release();
    }
  });
});
