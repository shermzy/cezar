import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SdlcBaseline, SdlcBaselineAction } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';

/**
 * The SDLC baseline (spec 2026-10-06-ai-native-sdlc-fleet): a small versioned set of files that
 * moves a repository toward the AI-native SDLC, and the arithmetic of offering it safely.
 *
 * The contract with the repository is deliberately narrow:
 *   - a file that already exists and that cezar did not write is NEVER modified;
 *   - cezar records the hash of everything it writes in `.claude/cezar-baseline.json`, so a later
 *     version may update a file nobody has touched and must leave one a person edited;
 *   - the repository owns its copy afterwards — deleting cezar leaves it working.
 */

export const MANIFEST_PATH = '.claude/cezar-baseline.json';
const MAX_FILES = 50;
const MAX_FILE_BYTES = 64 * 1024;

export interface BaselineFile {
  path: string;
  content: string;
}

export interface Baseline {
  version: number;
  source: 'built-in' | 'override';
  files: BaselineFile[];
}

const bundleManifestSchema = z.object({
  version: z.number().int().positive(),
  files: z.array(z.object({ source: z.string().min(1), path: z.string().min(1) })).min(1).max(MAX_FILES),
});

const repoManifestSchema = z.object({
  version: z.number().int().nonnegative(),
  files: z.record(z.string(), z.string()),
});
type RepoManifest = z.infer<typeof repoManifestSchema>;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const builtInDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'baseline');

/** A repo-relative POSIX path that cannot leave the repository or touch the manifest. */
function safeRelativePath(path: string): boolean {
  if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes('\\')) return false;
  if (path.split('/').some((part) => part === '..' || part === '' || part === '.')) return false;
  return path !== MANIFEST_PATH;
}

async function readBundle(dir: string, source: Baseline['source']): Promise<Baseline> {
  const manifest = bundleManifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  const files: BaselineFile[] = [];
  for (const entry of manifest.files) {
    if (!safeRelativePath(entry.path)) throw new Error(`unsafe baseline path: ${entry.path}`);
    const from = resolve(dir, entry.source);
    if (relative(dir, from).startsWith('..')) throw new Error(`baseline source leaves its directory: ${entry.source}`);
    const content = await readFile(from, 'utf8');
    if (content.length === 0 || Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new Error(`baseline file has a bad size: ${entry.path}`);
    }
    files.push({ path: entry.path, content });
  }
  return { version: manifest.version, source, files };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

/**
 * The shipped baseline, unless `~/.cezar/sdlc-baseline/` holds a valid one. An invalid override
 * warns once and falls back — a bad file in the user's home must never block the audit.
 */
export async function loadBaseline(options: LoadOptions = {}): Promise<Baseline> {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const overrideDir = join(cezarHomeDir(options.env), 'sdlc-baseline');
  try {
    await readFile(join(overrideDir, 'manifest.json'), 'utf8');
  } catch {
    return readBundle(builtInDir(), 'built-in');
  }
  try {
    return await readBundle(overrideDir, 'override');
  } catch (err) {
    warn(`cezar: ignoring ${overrideDir}: ${err instanceof Error ? err.message : String(err)}`);
    return readBundle(builtInDir(), 'built-in');
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readManifest(root: string): Promise<RepoManifest | null> {
  const raw = await readOptional(join(root, MANIFEST_PATH));
  if (raw === null) return null;
  try {
    return repoManifestSchema.parse(JSON.parse(raw));
  } catch {
    return null; // corrupt: behave as if cezar had never written here
  }
}

/** `{{test}}` / `{{lint}}` come from package.json; a placeholder with no source stays literal. */
async function render(root: string, file: BaselineFile): Promise<{ content: string; unfilled: boolean }> {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg: unknown = JSON.parse((await readOptional(join(root, 'package.json'))) ?? '');
    if (pkg && typeof pkg === 'object' && 'scripts' in pkg && pkg.scripts && typeof pkg.scripts === 'object') {
      scripts = pkg.scripts as Record<string, unknown>;
    }
  } catch {
    // no readable package.json: placeholders stay literal
  }
  const lintKey = ['lint', 'typecheck', 'check'].find((k) => k in scripts);
  const values: Record<string, string | undefined> = {
    test: 'test' in scripts ? 'npm test' : undefined,
    lint: lintKey ? `npm run ${lintKey}` : undefined,
  };
  let unfilled = false;
  const content = file.content.replace(/\{\{(test|lint)\}\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) {
      unfilled = true;
      return whole;
    }
    return value;
  });
  return { content, unfilled };
}

interface PlannedFile {
  path: string;
  action: SdlcBaselineAction;
  content: string;
  unfilled: boolean;
}

async function plan(root: string, baseline: Baseline): Promise<PlannedFile[]> {
  const manifest = await readManifest(root);
  const planned: PlannedFile[] = [];
  for (const file of baseline.files) {
    const { content, unfilled } = await render(root, file);
    const onDisk = await readOptional(join(root, file.path));
    const tracked = manifest?.files[file.path];
    let action: SdlcBaselineAction;
    if (onDisk === null) action = 'create';
    else if (sha256(onDisk) === sha256(content)) action = 'skip-current';
    else if (tracked !== undefined && sha256(onDisk) === tracked) action = 'update';
    else action = 'skip-diverged';
    planned.push({ path: file.path, action, content, unfilled });
  }
  return planned;
}

/** What `apply` would do, writing nothing. */
export async function planBaseline(root: string, baseline: Baseline): Promise<Array<{ path: string; action: SdlcBaselineAction }>> {
  return (await plan(root, baseline)).map(({ path, action }) => ({ path, action }));
}

export interface ApplyResult {
  written: string[];
  skipped: Array<{ path: string; action: SdlcBaselineAction }>;
  /** Written files that still carry a `{{placeholder}}` the operator must fill in. */
  unfilled: string[];
}

/** Write what the plan says to create or update, then record what cezar now owns. Idempotent. */
export async function applyBaseline(root: string, baseline: Baseline): Promise<ApplyResult> {
  const absRoot = resolve(root);
  // Check every destination before writing any, so a bad bundle cannot leave a half-applied repo.
  for (const file of baseline.files) {
    const rel = relative(absRoot, resolve(absRoot, file.path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing to write outside the repository: ${file.path}`);
  }
  const planned = await plan(absRoot, baseline);
  const previous = await readManifest(absRoot);
  const hashes: Record<string, string> = {};
  const result: ApplyResult = { written: [], skipped: [], unfilled: [] };

  for (const file of planned) {
    if (file.action === 'create' || file.action === 'update') {
      const target = resolve(absRoot, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
      result.written.push(file.path);
      if (file.unfilled) result.unfilled.push(file.path);
      hashes[file.path] = sha256(file.content);
    } else {
      result.skipped.push({ path: file.path, action: file.action });
      if (file.action === 'skip-current') hashes[file.path] = sha256(file.content);
      else if (previous?.files[file.path] !== undefined) hashes[file.path] = previous.files[file.path] as string;
    }
  }

  const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
  const manifest = `${JSON.stringify({ version: baseline.version, files: sorted }, null, 2)}\n`;
  const manifestPath = join(absRoot, MANIFEST_PATH);
  if ((await readOptional(manifestPath)) !== manifest) {
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifest);
  }
  return result;
}

/** Where a repository stands against `baseline`, for the audit matrix. */
export async function baselineAudit(root: string, baseline: Baseline): Promise<SdlcBaseline> {
  const manifest = await readManifest(root);
  if (!manifest) return { state: 'none', files: [] };
  const files: SdlcBaseline['files'] = [];
  for (const file of baseline.files) {
    const onDisk = await readOptional(join(root, file.path));
    const tracked = manifest.files[file.path];
    files.push({
      path: file.path,
      state: onDisk === null ? 'missing' : tracked !== undefined && sha256(onDisk) === tracked ? 'untouched' : 'diverged',
    });
  }
  const state = manifest.version < baseline.version ? 'outdated' : files.some((f) => f.state !== 'untouched') ? 'diverged' : 'current';
  return { state, version: manifest.version, files };
}
