import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyBaseline, loadBaseline, planBaseline, type Baseline } from './baseline.ts';

/**
 * `cez sdlc baseline <plan|apply> [--into <dir>]` — the deterministic step the `sdlc-baseline`
 * workflow runs inside a task worktree (spec 2026-10-06-ai-native-sdlc-fleet). No server, no
 * agent, no network: it reads the baseline and writes files into `--into` (default: the cwd).
 *
 * Exit codes follow the other `cez` subcommands: 0 done, 1 the work failed, 2 bad usage.
 */

export interface SdlcCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Injectable so a test can supply a tiny bundle; production loads the real one. */
  loadBaseline?: () => Promise<Baseline>;
}

const USAGE = `cez sdlc — adopt the AI-native SDLC baseline in a repository

  cez sdlc baseline plan  [--into <dir>]   show what apply would do, write nothing
  cez sdlc baseline apply [--into <dir>]   create the missing baseline files; never edits an existing file

--into defaults to the current directory.`;

export async function runSdlcCommand(argv: string[], io: Partial<SdlcCliIo> = {}): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));

  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { into: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    error(USAGE);
    return 2;
  }
  const [group, action, ...rest] = parsed.positionals;
  if (parsed.values.help || group !== 'baseline' || (action !== 'plan' && action !== 'apply') || rest.length > 0) {
    (parsed.values.help ? log : error)(USAGE);
    return parsed.values.help ? 0 : 2;
  }

  const root = resolve(parsed.values.into ?? process.cwd());
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    error(`cez sdlc: ${root} is not a directory`);
    return 1;
  }

  try {
    const baseline = await (io.loadBaseline ?? (() => loadBaseline()))();
    if (action === 'plan') {
      for (const file of await planBaseline(root, baseline)) log(`${file.action.padEnd(13)} ${file.path}`);
      return 0;
    }
    const result = await applyBaseline(root, baseline);
    log(`SDLC baseline v${baseline.version} (${baseline.source}) into ${root}`);
    for (const path of result.written) log(`wrote   ${path}`);
    for (const { path, action: why } of result.skipped) log(`skipped ${path} (${why})`);
    if (result.written.length === 0) log('nothing to write: this repository is already current');
    for (const path of result.unfilled) {
      log(`NOTE ${path} still has a {{placeholder}} (no test/lint script in package.json): fill it in before merging`);
    }
    return 0;
  } catch (err) {
    error(`cez sdlc: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
