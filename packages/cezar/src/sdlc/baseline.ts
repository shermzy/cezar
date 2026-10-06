import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Hash of the TEXT, not the bytes: line endings are normalised first. A baseline checked out on
 * Windows is CRLF, one built on Linux is LF, and git rewrites a repository's own files either way
 * (`core.autocrlf`); none of that is an edit by a person, and treating it as one would mark every
 * file `diverged` the moment the repo changed machines.
 */
const sha256 = (text: string) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

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

type InspectedFile = { kind: 'missing' | 'unreadable' | 'unsafe' } | { kind: 'readable'; content: string };
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** Baseline reads never follow links or consume more than one small file's budget. */
async function inspectFile(root: string, rel: string): Promise<InspectedFile> {
  if (rel !== MANIFEST_PATH && !safeRelativePath(rel)) return { kind: 'unsafe' };
  const parts = rel.split('/');
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let entry;
    try {
      entry = await lstat(path);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
    }
    if (entry.isSymbolicLink()) return { kind: 'unsafe' };
    if (index < parts.length - 1 && !entry.isDirectory()) return { kind: 'unreadable' };
    if (index === parts.length - 1 && (!entry.isFile() || entry.size > MAX_FILE_BYTES)) return { kind: 'unreadable' };
  }
  try {
    const actual = await realpath(path);
    if (!within(root, actual)) return { kind: 'unsafe' };
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // Re-check after opening, so a replaced final symlink is not read.
      if ((await lstat(path)).isSymbolicLink()) return { kind: 'unsafe' };
      const data = Buffer.alloc(MAX_FILE_BYTES + 1);
      let used = 0;
      while (used < data.length) {
        const { bytesRead } = await handle.read(data, used, data.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      return used > MAX_FILE_BYTES ? { kind: 'unreadable' } : { kind: 'readable', content: data.toString('utf8', 0, used) };
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Replace a known Cezar-owned file by renaming a new entry, never by following its inode. */
async function replaceContained(root: string, rel: string, content: string, expected: string): Promise<void> {
  const target = resolve(root, rel);
  const parent = dirname(target);
  if (!within(root, await realpath(parent))) throw new Error(`refusing to write outside the repository: ${rel}`);
  const temporary = join(parent, `.cezar-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      if (!within(root, await realpath(temporary))) throw new Error(`refusing to write outside the repository: ${rel}`);
      const current = await inspectFile(root, rel);
      if (current.kind !== 'readable' || current.content !== expected) throw new Error(`baseline target changed before write: ${rel}`);
      const entry = await lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`baseline target changed before write: ${rel}`);
      await handle.chmod(entry.mode & 0o777);
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

interface ManifestRead {
  value: RepoManifest | null;
  /** An existing but invalid manifest belongs to the repository and must not be replaced. */
  existing: boolean;
}

async function readManifest(root: string): Promise<ManifestRead> {
  const inspected = await inspectFile(root, MANIFEST_PATH);
  if (inspected.kind !== 'readable') return { value: null, existing: inspected.kind !== 'missing' };
  try {
    return { value: repoManifestSchema.parse(JSON.parse(inspected.content)), existing: true };
  } catch {
    return { value: null, existing: true };
  }
}

/** `{{test}}` / `{{lint}}` come from package.json; a placeholder with no source stays literal. */
async function render(root: string, file: BaselineFile): Promise<{ content: string; unfilled: boolean }> {
  let scripts: Record<string, unknown> = {};
  try {
    const packageFile = await inspectFile(root, 'package.json');
    const pkg: unknown = JSON.parse(packageFile.kind === 'readable' ? packageFile.content : '');
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
  const manifest = (await readManifest(root)).value;
  const planned: PlannedFile[] = [];
  for (const file of baseline.files) {
    const { content, unfilled } = await render(root, file);
    const onDisk = await inspectFile(root, file.path);
    const tracked = manifest?.files[file.path];
    let action: SdlcBaselineAction;
    if (onDisk.kind === 'missing') action = 'create';
    else if (onDisk.kind !== 'readable') action = 'skip-diverged';
    else if (sha256(onDisk.content) === sha256(content)) action = 'skip-current';
    else if (tracked !== undefined && sha256(onDisk.content) === tracked) action = 'update';
    else action = 'skip-diverged';
    planned.push({ path: file.path, action, content, unfilled });
  }
  return planned;
}

/** What `apply` would do, writing nothing. */
export async function planBaseline(root: string, baseline: Baseline): Promise<Array<{ path: string; action: SdlcBaselineAction }>> {
  return (await plan(await realpath(root), baseline)).map(({ path, action }) => ({ path, action }));
}

export interface ApplyResult {
  written: string[];
  skipped: Array<{ path: string; action: SdlcBaselineAction }>;
  /** Written files that still carry a `{{placeholder}}` the operator must fill in. */
  unfilled: string[];
}

/** Write what the plan says to create or update, then record what cezar now owns. Idempotent. */
export async function applyBaseline(root: string, baseline: Baseline): Promise<ApplyResult> {
  const absRoot = await realpath(root);
  // Check every destination before writing any, so a bad bundle cannot leave a half-applied repo.
  for (const file of baseline.files) {
    const rel = relative(absRoot, resolve(absRoot, file.path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing to write outside the repository: ${file.path}`);
    if ((await inspectFile(absRoot, file.path)).kind === 'unsafe') throw new Error(`refusing symlink or unsafe baseline path: ${file.path}`);
  }
  if ((await inspectFile(absRoot, MANIFEST_PATH)).kind === 'unsafe') throw new Error(`refusing symlink or unsafe baseline path: ${MANIFEST_PATH}`);
  const planned = await plan(absRoot, baseline);
  const previous = await readManifest(absRoot);
  const hashes: Record<string, string> = {};
  const result: ApplyResult = { written: [], skipped: [], unfilled: [] };

  for (const file of planned) {
    if (file.action === 'create' || file.action === 'update') {
      const target = resolve(absRoot, file.path);
      await mkdir(dirname(target), { recursive: true });
      const beforeWrite = await inspectFile(absRoot, file.path);
      if ((file.action === 'create' && beforeWrite.kind !== 'missing') ||
          (file.action === 'update' && (beforeWrite.kind !== 'readable' || sha256(beforeWrite.content) !== previous.value?.files[file.path]))) {
        throw new Error(`baseline target changed before write: ${file.path}`);
      }
      if (file.action === 'create') {
        if (!within(absRoot, await realpath(dirname(target)))) throw new Error(`refusing to write outside the repository: ${file.path}`);
        await writeFile(target, file.content, { flag: 'wx' });
      } else {
        await replaceContained(absRoot, file.path, file.content, beforeWrite.kind === 'readable' ? beforeWrite.content : '');
      }
      result.written.push(file.path);
      if (file.unfilled) result.unfilled.push(file.path);
      hashes[file.path] = sha256(file.content);
    } else {
      result.skipped.push({ path: file.path, action: file.action });
      if (previous.value?.files[file.path] !== undefined) hashes[file.path] = previous.value.files[file.path] as string;
    }
  }

  const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
  const manifest = `${JSON.stringify({ version: baseline.version, files: sorted }, null, 2)}\n`;
  const manifestPath = join(absRoot, MANIFEST_PATH);
  const existingManifest = await inspectFile(absRoot, MANIFEST_PATH);
  if ((!previous.existing || previous.value !== null) && (existingManifest.kind === 'missing' || (existingManifest.kind === 'readable' && existingManifest.content !== manifest))) {
    await mkdir(dirname(manifestPath), { recursive: true });
    if (existingManifest.kind === 'missing') {
      if (!within(absRoot, await realpath(dirname(manifestPath)))) throw new Error(`refusing to write outside the repository: ${MANIFEST_PATH}`);
      await writeFile(manifestPath, manifest, { flag: 'wx' });
    } else if (existingManifest.kind === 'readable') {
      await replaceContained(absRoot, MANIFEST_PATH, manifest, existingManifest.content);
    }
  }
  return result;
}

/** Where a repository stands against `baseline`, for the audit matrix. */
export async function baselineAudit(root: string, baseline: Baseline): Promise<SdlcBaseline> {
  const absRoot = await realpath(root);
  const manifest = (await readManifest(absRoot)).value;
  if (!manifest) return { state: 'none', files: [] };
  const files: SdlcBaseline['files'] = [];
  for (const file of baseline.files) {
    const onDisk = await inspectFile(absRoot, file.path);
    const tracked = manifest.files[file.path];
    files.push({
      path: file.path,
      state: onDisk.kind === 'missing' ? 'missing' : onDisk.kind === 'readable' && tracked !== undefined && sha256(onDisk.content) === tracked ? 'untouched' : 'diverged',
    });
  }
  const state = manifest.version < baseline.version ? 'outdated' : files.some((f) => f.state !== 'untouched') ? 'diverged' : 'current';
  return { state, version: manifest.version, files };
}
