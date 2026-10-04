import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DISCLAIM_EXEC_FLAG, disclaimedCommand } from './disclaim-spawn.ts';

const dir = mkdtempSync(join(tmpdir(), 'cez-disclaim-'));
const exe = (name: string) => {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
};
const trampoline = exe('Cezar');
const claude = exe('claude');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const darwin = { platform: 'darwin' as const, hostEnv: { CEZ_DISCLAIM_EXEC: trampoline } };

describe('disclaimedCommand', () => {
  it('routes an agent through the desktop trampoline, resolved on the child PATH', () => {
    expect(disclaimedCommand('claude', ['-p', 'x'], { PATH: `/nowhere:${dir}` }, darwin))
      .toEqual([trampoline, [DISCLAIM_EXEC_FLAG, claude, '-p', 'x']]);
    expect(disclaimedCommand(claude, [], {}, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, claude]]);
  });

  it('leaves the command alone outside the desktop app and off macOS', () => {
    expect(disclaimedCommand('claude', ['-p'], { PATH: dir }, { platform: 'darwin', hostEnv: {} })).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('claude', ['-p'], { PATH: dir }, { ...darwin, platform: 'linux' })).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('claude', [], { PATH: dir }, { platform: 'darwin', hostEnv: { CEZ_DISCLAIM_EXEC: join(dir, 'gone') } }))
      .toEqual(['claude', []]);
  });

  it('keeps a missing program a plain spawn, so ENOENT and its install hint survive', () => {
    expect(disclaimedCommand('codex', ['app-server'], { PATH: dir }, darwin)).toEqual(['codex', ['app-server']]);
    expect(disclaimedCommand('./claude', [], { PATH: dir }, darwin)).toEqual(['./claude', []]);
  });
});

// Windows cannot execute a `#!` script, so spawning one directly dies with EFTYPE; the dry-run
// mock agent (`scripts/mock-claude.mjs`) is exactly that. Node scripts go through node there.
describe('disclaimedCommand on Windows', () => {
  const win32 = { platform: 'win32' as const, hostEnv: {} };

  it('runs a node-script agent binary through node', () => {
    expect(disclaimedCommand('C:\\x\\mock-claude.mjs', ['-p', 'hi'], {}, win32))
      .toEqual([process.execPath, ['C:\\x\\mock-claude.mjs', '-p', 'hi']]);
    expect(disclaimedCommand('C:\\x\\mock-claude.mjs', [], {}, win32))
      .toEqual([process.execPath, ['C:\\x\\mock-claude.mjs']]);
  });

  it('matches the script extension case-insensitively, for .cjs and .js too', () => {
    expect(disclaimedCommand('C:\\x\\agent.CJS', ['a'], {}, win32)).toEqual([process.execPath, ['C:\\x\\agent.CJS', 'a']]);
    expect(disclaimedCommand('C:\\x\\agent.js', ['a'], {}, win32)).toEqual([process.execPath, ['C:\\x\\agent.js', 'a']]);
    expect(disclaimedCommand('C:\\x\\agent.MJS', [], {}, win32)).toEqual([process.execPath, ['C:\\x\\agent.MJS']]);
  });

  it('leaves a real executable alone', () => {
    expect(disclaimedCommand('claude.exe', ['-p', 'x'], {}, win32)).toEqual(['claude.exe', ['-p', 'x']]);
    expect(disclaimedCommand('claude', ['-p'], {}, win32)).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('C:\\x\\agent.mjs.exe', [], {}, win32)).toEqual(['C:\\x\\agent.mjs.exe', []]);
  });

  it('does not apply off Windows, where the shebang runs', () => {
    expect(disclaimedCommand('/x/mock-claude.mjs', ['-p'], {}, { platform: 'linux', hostEnv: {} }))
      .toEqual(['/x/mock-claude.mjs', ['-p']]);
  });

  it('leaves the macOS trampoline route untouched for a node script', () => {
    // Forward slashes, so the darwin branch resolves the path the same way on any test host.
    const script = exe('mock-claude.mjs').replaceAll('\\', '/');
    expect(disclaimedCommand(script, ['-p'], {}, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, script, '-p']]);
  });
});
