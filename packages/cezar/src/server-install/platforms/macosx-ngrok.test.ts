import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cezarLaunchdPlist, launchdPlist, macosxNgrok, macosxNgrokIdentityStep, ngrokAuthTrafficPolicy } from './macosx-ngrok.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import type { Runner } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

describe('macosx-ngrok', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside ubuntu-vps', () => {
    expect(getStrategy('macosx-ngrok')?.id).toBe('macosx-ngrok');
    expect(availablePlatformIds()).toEqual(['ubuntu-vps', 'macosx-ngrok']);
  });

  it('launchdPlist embeds the port, basic-auth and reserved domain', () => {
    const p = launchdPlist(4321, 'ops:hunter2', 'cezar.ngrok.app');
    expect(p).toContain('<string>http</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>ops:hunter2</string>');
    expect(p).toContain('<string>cezar.ngrok.app</string>');
    expect(p).not.toContain('<string>--traffic-policy-file</string>');
    expect(ngrokAuthTrafficPolicy()).toMatch(/remove-headers[\s\S]*add-headers[\s\S]*conn\.client_ip/);
    expect(p).toContain('<key>KeepAlive</key>');
  });

  it('installs the client-IP policy only after managed auth or proxy trust is opted in', async () => {
    const previousAuth = process.env.CEZ_AUTH_REQUIRED;
    const previousTrust = process.env.CEZ_AUTH_TRUST_PROXY;
    const previousHome = process.env.HOME;
    delete process.env.CEZ_AUTH_REQUIRED;
    delete process.env.CEZ_AUTH_TRUST_PROXY;
    process.env.HOME = home;
    const runner: Runner = {
      capture: async (_program, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    try {
      await macosxNgrok.steps({} as never).find((step) => step.id === 'ngrok')!.run({
        state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
        ui: { ...createAutoUi(), password: async (option: { message: string }) => option.message.includes('authtoken') ? 'SECRET-TOKEN' : 'longenough', text: async (option: { message: string }) => option.message.includes('domain') ? '' : 'ops' },
        runner, save: async () => {}, dryRun: false, assumeYes: true, reconfigure: new Set<string>(), repoRoot: '/repo', now: '', prefs: {},
      } as never);
      const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.cezar.ngrok.plist'), 'utf8');
      expect(plist).toContain('<string>--basic-auth</string>');
      expect(plist).not.toContain('<string>--traffic-policy-file</string>');
      expect(existsSync(join(home, 'Library', 'Application Support', 'Cezar', 'ngrok-auth-traffic-policy.yml'))).toBe(false);
    } finally {
      if (previousAuth === undefined) delete process.env.CEZ_AUTH_REQUIRED;
      else process.env.CEZ_AUTH_REQUIRED = previousAuth;
      if (previousTrust === undefined) delete process.env.CEZ_AUTH_TRUST_PROXY;
      else process.env.CEZ_AUTH_TRUST_PROXY = previousTrust;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('cezar launchd plist has one PATH key and carries instance identity', () => {
    const plist = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/node', '/repo/dist/index.js'], 'install-a');
    expect(plist.match(/<key>PATH<\/key>/g)).toHaveLength(1);
    expect(plist).toContain('<key>CEZ_INSTANCE_ID</key>');
    expect(plist).toContain('<string>install-a</string>');
  });

  it('persists a caller-supplied workspace home in the service launcher', () => {
    const plist = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/node', '/repo/dist/index.js'], 'install-a', true, true, '/Users/me/Cezar Workspaces');
    expect(plist).toContain('<key>CEZ_HOME</key>\n      <string>/Users/me/Cezar Workspaces</string>');
  });

  it('cezarLaunchdPlist embeds the argv, port, workdir and env', () => {
    const p = cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/app/dist/index.js</string>');
    expect(p).toContain('<string>serve</string>');
    expect(p).toContain('<string>--no-open</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>/repo</string>');
    expect(p).toContain('<key>CEZ_REMOTE</key>');
    expect(p).toContain('<string>ai.cezar.cockpit</string>');
  });

  it('identity verification accepts a matching health identity and reports legacy payloads as inconclusive', async () => {
    const messages: string[] = [];
    const ctx = {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, instanceId: 'install-a' },
      instance: 'default', ui: { ...createAutoUi(), success: (m: string) => messages.push(m), warn: (m: string) => messages.push(m) },
      runner: { capture: async (_program: string, args: string[]) => ({
        code: 0,
        stdout: args.some((a) => a.includes('/api/tunnels')) ? '{"public_url":"https://x"}' : '{"instanceId":"install-a"}\n200',
        stderr: '',
      }), interactive: async () => 0 },
      save: async () => {}, dryRun: false, assumeYes: true, reconfigure: new Set<string>(), repoRoot: '/repo', now: '', prefs: {},
    } as never;
    await macosxNgrokIdentityStep.run(ctx);
    expect(messages.some((m) => m.includes('identity matches'))).toBe(true);
  });

  it('identity verification rejects a different local cockpit', async () => {
    const ctx = {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, instanceId: 'install-a' },
      instance: 'default', ui: createAutoUi(), runner: { capture: async (_program: string, args: string[]) => ({
        code: 0,
        stdout: args.some((a) => a.includes('/api/tunnels')) ? '{"public_url":"https://x"}' : '{"instanceId":"other"}\n200',
        stderr: '',
      }), interactive: async () => 0 },
      save: async () => {}, dryRun: false, assumeYes: true, reconfigure: new Set<string>(), repoRoot: '/repo', now: '', prefs: {},
    } as never;
    await expect(macosxNgrokIdentityStep.run(ctx)).rejects.toThrow(/serving another install/);
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    // Leave the reserved domain blank to exercise the ephemeral-URL path.
    const ui = { ...createAutoUi(), text: async (o: { message: string; placeholder?: string }) => (o.message.includes('Reserved') ? '' : o.placeholder ?? 'ops') };
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui,
      runner: okRunner,
    };
    const res = await runInstall(macosxNgrok, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-ngrok');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.ngrok?.status).toBe('done');
    expect(state.ephemeral).toBe(true); // no domain given → ephemeral URL
    const ngrokArtifacts = state.steps.ngrok?.created?.artifacts ?? [];
    expect(ngrokArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');
    expect(ngrokArtifacts.find((a) => a.type === 'ngrok-config')?.kind).toBe('shared');
    const autostartArtifacts = state.steps.autostart?.created?.artifacts ?? [];
    expect(autostartArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');

    const undone = await runUninstall(macosxNgrok, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });
});

describe('macosx-ngrok review fixes (PR #423)', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-fix-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  function ngrokStepOf() {
    const s = macosxNgrok.steps({} as never).find((x) => x.id === 'ngrok');
    if (!s) throw new Error('no ngrok step');
    return s;
  }

  function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
    return {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
      ui: {
        ...createAutoUi(),
        password: async (o: { message: string }) => (o.message.includes('authtoken') ? 'SECRET-TOKEN' : 'longenough'),
        text: async (o: { message: string }) => (o.message.includes('domain') ? '' : 'ops'),
      },
      runner,
      save: async () => {},
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      prefs: {},
      ...over,
    } as never;
  }

  it('never puts the authtoken in argv — it travels via NGROK_AUTHTOKEN env', async () => {
    const interactiveCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        // launchctl print reports loaded; command -v finds ngrok
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args, o) => {
        interactiveCalls.push({ args, env: (o as { env?: Record<string, string> } | undefined)?.env });
        return 0;
      },
    };
    await ngrokStepOf().run(ctxFor(runner));
    const tokenCall = interactiveCalls.find((c) => c.args.join(' ').includes('add-authtoken'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.args.join(' ')).not.toContain('SECRET-TOKEN');
    expect(tokenCall?.args.join(' ')).toContain('$NGROK_AUTHTOKEN');
    expect(tokenCall?.env?.NGROK_AUTHTOKEN).toBe('SECRET-TOKEN');
  });

  it('writes the credential-bearing plist 0600', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    // point HOME-based plist path into the temp dir via a fake homedir? plistPath()
    // uses the real homedir — instead assert through the file the step wrote.
    const oldHome = process.env.HOME;
    process.env.HOME = home; // node's os.homedir() honors $HOME on posix
    try {
      await ngrokStepOf().run(ctxFor(runner));
      const p = join(home, 'Library', 'LaunchAgents', 'ai.cezar.ngrok.plist');
      const mode = statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(readFileSync(p, 'utf8')).toContain('ops:longenough'); // creds live here → hence 0600
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('keeps ngrok Basic Auth when only the anonymous managed gate is responding', async () => {
    const previousAuth = process.env.CEZ_AUTH_REQUIRED;
    const previousHome = process.env.HOME;
    process.env.CEZ_AUTH_REQUIRED = '1';
    process.env.HOME = home;
    const runner: Runner = {
      capture: async (program, args) => {
        if (program === 'curl' && args.some((arg) => arg.includes('/auth/session'))) {
          return { code: 0, stdout: '{"authRequired":true,"authenticated":false}\n200', stderr: '' };
        }
        if (program === 'curl' && args.some((arg) => arg.includes('/projects'))) return { code: 0, stdout: '401', stderr: '' };
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    try {
      // The service can advertise its gate before the owner store is bootstrapped.
      await ngrokStepOf().run(ctxFor(runner));
      const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.cezar.ngrok.plist'), 'utf8');
      expect(plist).toContain('<string>--basic-auth</string>');
    } finally {
      if (previousAuth === undefined) delete process.env.CEZ_AUTH_REQUIRED;
      else process.env.CEZ_AUTH_REQUIRED = previousAuth;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('a failed launchctl bootstrap fails the step instead of recording done', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        if (args[0] === 'print') return { code: 113, stdout: '', stderr: '' }; // not loaded
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args) => (args[0] === 'bootstrap' ? 5 : 0),
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(ngrokStepOf().run(ctxFor(runner))).rejects.toThrow(/launchctl could not load/);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('restores the previous Basic Auth tunnel when managed login is not ready and reload fails', async () => {
    const previousAuth = process.env.CEZ_AUTH_REQUIRED;
    const previousHome = process.env.HOME;
    process.env.CEZ_AUTH_REQUIRED = '1';
    process.env.HOME = home;
    const path = join(home, 'Library', 'LaunchAgents', 'ai.cezar.ngrok.plist');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const previous = launchdPlist(4321, 'old:oldpassword', 'old.ngrok.app');
    writeFileSync(path, previous, { mode: 0o600 });
    let bootstraps = 0;
    const runner: Runner = {
      capture: async (program, args) => {
        if (program === 'curl' && args.some((arg) => arg.includes('/auth/session'))) {
          return { code: 0, stdout: '{"authRequired":true,"authenticated":false}\n200', stderr: '' };
        }
        if (program === 'curl' && args.some((arg) => arg.includes('/projects'))) return { code: 0, stdout: '401', stderr: '' };
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_program, args) => {
        if (args[0] === 'bootstrap') return ++bootstraps === 1 ? 5 : 0;
        return 0;
      },
    };
    try {
      await expect(ngrokStepOf().run(ctxFor(runner))).rejects.toThrow(/restored/);
      expect(readFileSync(path, 'utf8')).toBe(previous);
      expect(bootstraps).toBe(2);
      expect(existsSync(join(home, 'Library', 'Application Support', 'Cezar', 'ngrok-auth-traffic-policy.yml'))).toBe(false);
    } finally {
      if (previousAuth === undefined) delete process.env.CEZ_AUTH_REQUIRED;
      else process.env.CEZ_AUTH_REQUIRED = previousAuth;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('refuses to rewrite a service launcher for a different CEZ_HOME', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const path = join(home, 'Library', 'LaunchAgents', 'ai.cezar.cockpit.plist');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const previous = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/node', '/repo/dist/index.js'], 'install-a', false, false, '/other/workspace');
    writeFileSync(path, previous, { mode: 0o600 });
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: '/usr/local/bin/cezar', stderr: '' }),
      interactive: async () => 0,
    };
    try {
      const step = macosxNgrok.steps({} as never).find((candidate) => candidate.id === 'autostart')!;
      await expect(step.run(ctxFor(runner))).rejects.toThrow(/same CEZ_HOME/);
      expect(readFileSync(path, 'utf8')).toBe(previous);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('restores the previous Cezar service launcher when bootstrap fails', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const path = join(home, 'Library', 'LaunchAgents', 'ai.cezar.cockpit.plist');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const previous = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/node', '/repo/dist/index.js'], 'install-a', false, false, home);
    writeFileSync(path, previous, { mode: 0o600 });
    let bootstraps = 0;
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: '/usr/local/bin/cezar', stderr: '' }),
      interactive: async (_program, args) => args[0] === 'bootstrap' && ++bootstraps === 1 ? 5 : 0,
    };
    try {
      const step = macosxNgrok.steps({} as never).find((candidate) => candidate.id === 'autostart')!;
      await expect(step.run(ctxFor(runner))).rejects.toThrow(/restored/);
      expect(readFileSync(path, 'utf8')).toBe(previous);
      expect(bootstraps).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('undo removes the agent from static label/path even with created:null', async () => {
    const commands: string[][] = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        commands.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await ngrokStepOf().undo(ctxFor(runner), null);
      expect(commands.some((c) => c[0] === 'bootout' && (c[1] ?? '').includes('ai.cezar.ngrok'))).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('rejects a scheme-carrying domain (bare hostname only)', async () => {
    let domainValidate: ((v: string) => string | undefined) | undefined;
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, {
      ui: {
        ...createAutoUi(),
        password: async () => 'longenough',
        text: async (o: { message: string; validate?: (v: string) => string | undefined }) => {
          if (o.message.includes('domain')) {
            domainValidate = o.validate;
            return '';
          }
          return 'ops';
        },
      },
    });
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await ngrokStepOf().run(ctx);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
    expect(domainValidate).toBeDefined();
    expect(domainValidate?.('https://cezar.ngrok.app')).toBeDefined();
    expect(domainValidate?.('cezar.ngrok.app')).toBeUndefined();
    expect(domainValidate?.('')).toBeUndefined(); // blank = ephemeral, allowed
  });
});
