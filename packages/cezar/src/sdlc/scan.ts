import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { SdlcPlayId, SdlcPlayResult, SdlcScore } from '@open-mercato/cezar-contract';
import { PLAYS } from './plays.ts';

/**
 * The deterministic SDLC audit of one project (spec 2026-10-06-ai-native-sdlc-fleet).
 *
 * Read-only and bounded by construction: only fixed paths and fixed directory listings are
 * touched, each file is read at most `READ_CAP` bytes, nothing is parsed beyond a guarded
 * `JSON.parse`, and a symlink that leaves the repository is never followed. Every failure inside a
 * detector degrades that detector to Absent — a malformed workflow must never fail the scan.
 */

const READ_CAP = 64 * 1024;
const MAX_WORKFLOWS = 40;
const MAX_EVIDENCE = 5;
const CLAUDE_MD_MAX_LINES = 150;

export interface ProjectScan {
  status: 'ok' | 'missing' | 'not-git';
  results: SdlcPlayResult[];
}

interface Text {
  text: string;
  truncated: boolean;
}

/** A path under `root` whose real location is still inside `root`, or null. */
async function inside(root: string, rel: string): Promise<string | null> {
  try {
    const full = join(root, rel);
    const [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
    return real === realRoot || real.startsWith(realRoot + sep) ? full : null;
  } catch {
    return null;
  }
}

async function readCapped(root: string, rel: string): Promise<Text | null> {
  const full = await inside(root, rel);
  if (!full) return null;
  try {
    if (!(await stat(full)).isFile()) return null;
    const handle = await open(full, 'r');
    try {
      const buf = Buffer.alloc(READ_CAP + 1);
      const { bytesRead } = await handle.read(buf, 0, READ_CAP + 1, 0);
      return { text: buf.subarray(0, Math.min(bytesRead, READ_CAP)).toString('utf8'), truncated: bytesRead > READ_CAP };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Names of regular entries directly inside `rel`, sorted; empty when it is absent or unreadable. */
async function listFiles(root: string, rel: string, ext?: RegExp): Promise<string[]> {
  const dir = await inside(root, rel);
  if (!dir) return [];
  try {
    const names = (await readdir(dir)).sort();
    const out: string[] = [];
    for (const name of names) {
      if (ext && !ext.test(name)) continue;
      const entry = await inside(root, `${rel}/${name}`);
      if (entry && (await stat(entry)).isFile()) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

async function listDirs(root: string, rel: string): Promise<string[]> {
  const dir = await inside(root, rel);
  if (!dir) return [];
  try {
    const out: string[] = [];
    for (const name of (await readdir(dir)).sort()) {
      const entry = await inside(root, `${rel}/${name}`);
      if (entry && (await stat(entry)).isDirectory()) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

async function exists(root: string, rel: string): Promise<boolean> {
  const full = await inside(root, rel);
  if (!full) return false;
  try {
    await stat(full);
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw: Text | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw.text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const VERIFY = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check)\b|\bpytest\b|\bgo test\b|\bcargo test\b|\bmake (?:test|check)\b|\bvitest\b|\bverif/i;

interface Context {
  root: string;
  claudeMd: Text | null;
  agentsMd: Text | null;
  settings: Record<string, unknown> | null;
  workflows: Array<{ path: string; text: string }>;
  intentFiles: string[];
}

function result(play: SdlcPlayId, score: SdlcScore, evidence: string[] = [], note?: string): SdlcPlayResult {
  return { play, score, evidence: evidence.slice(0, MAX_EVIDENCE), ...(note ? { note } : {}) };
}

/** Hook entries registered for one event: `{ matcher, hooks: [{ command }] }` groups, tolerated loosely. */
function hookGroups(settings: Record<string, unknown> | null, event: string): Array<{ matcher: string; commands: string[] }> {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const groups = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!group || typeof group !== 'object') return [];
    const g = group as { matcher?: unknown; hooks?: unknown };
    const commands = Array.isArray(g.hooks)
      ? g.hooks.flatMap((h) => (h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string' ? [(h as { command: string }).command] : []))
      : [];
    return [{ matcher: typeof g.matcher === 'string' ? g.matcher : '', commands }];
  });
}

async function markdownIn(root: string, dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) for (const name of await listFiles(root, dir, /\.md$/i)) out.push(`${dir}/${name}`);
  return out;
}

const isTemplate = (path: string) => /(?:^|\/)(?:template|readme)[^/]*$/i.test(path);

async function detectIntent(ctx: Context): Promise<SdlcPlayResult> {
  const files = await markdownIn(ctx.root, ['intent', '.ai/intent']);
  if (files.length === 0) return result('intent', 'absent');
  const real = files.filter((f) => !isTemplate(f));
  for (const file of real) {
    const text = await readCapped(ctx.root, file);
    if (text && /^\s*status\s*:/im.test(text.text)) return result('intent', 'present', real);
  }
  return result('intent', 'partial', files);
}

async function detectSpec(ctx: Context): Promise<SdlcPlayResult> {
  const specs = [
    ...((await exists(ctx.root, 'spec.md')) ? ['spec.md'] : []),
    ...(await markdownIn(ctx.root, ['specs', '.ai/specs'])),
  ];
  if (specs.length === 0) return result('spec', 'absent');
  const hasIntent = ctx.intentFiles.some((f) => !isTemplate(f));
  return hasIntent ? result('spec', 'present', specs) : result('spec', 'partial', specs, 'no intent file to trace the spec to');
}

async function detectPlan(ctx: Context): Promise<SdlcPlayResult> {
  const plans = [
    ...((await exists(ctx.root, 'plan.md')) ? ['plan.md'] : []),
    ...(await markdownIn(ctx.root, ['.ai/plans', 'docs/plans'])),
  ];
  if (plans.length > 0) return result('plan', 'present', plans);
  const hint = [ctx.claudeMd && 'CLAUDE.md', ctx.agentsMd && 'AGENTS.md'].filter((p): p is string => Boolean(p));
  const mentions = [ctx.claudeMd, ctx.agentsMd].some((t) => t && /plan mode/i.test(t.text));
  return mentions ? result('plan', 'partial', hint, 'plan mode is mentioned but no plan file is committed') : result('plan', 'absent');
}

function detectClaudeMd(ctx: Context): SdlcPlayResult {
  const doc = ctx.claudeMd;
  if (!doc) return ctx.agentsMd ? result('claude-md', 'partial', ['AGENTS.md'], 'AGENTS.md only, no CLAUDE.md') : result('claude-md', 'absent');
  const count = doc.text.split('\n').length;
  const lines = doc.truncated ? `${count}+` : String(count);
  if (doc.truncated || count > CLAUDE_MD_MAX_LINES) {
    return result('claude-md', 'partial', ['CLAUDE.md'], `CLAUDE.md is ${lines} lines (aim for under ${CLAUDE_MD_MAX_LINES})`);
  }
  return VERIFY.test(doc.text)
    ? result('claude-md', 'present', ['CLAUDE.md'])
    : result('claude-md', 'partial', ['CLAUDE.md'], 'no verify command named');
}

async function detectSkills(ctx: Context): Promise<SdlcPlayResult> {
  const found: string[] = [];
  for (const base of ['.claude/skills', '.ai/skills', '.agents/skills']) {
    for (const dir of await listDirs(ctx.root, base)) {
      if (await exists(ctx.root, `${base}/${dir}/SKILL.md`)) found.push(`${base}/${dir}/SKILL.md`);
    }
  }
  return found.length >= 2 ? result('skills', 'present', found) : found.length === 1 ? result('skills', 'partial', found) : result('skills', 'absent');
}

function detectBuildHooks(ctx: Context): SdlcPlayResult {
  const pre = hookGroups(ctx.settings, 'PreToolUse').length > 0;
  const post = hookGroups(ctx.settings, 'PostToolUse').length > 0;
  const evidence = ['.claude/settings.json'];
  if (pre && post) return result('build-hooks', 'present', evidence);
  if (pre || post) return result('build-hooks', 'partial', evidence, pre ? 'no PostToolUse hook' : 'no PreToolUse hook');
  return result('build-hooks', 'absent');
}

async function detectSubagents(ctx: Context): Promise<SdlcPlayResult> {
  const agents = (await listFiles(ctx.root, '.claude/agents', /\.md$/i)).map((n) => `.claude/agents/${n}`);
  return agents.length > 0 ? result('subagents', 'present', agents) : result('subagents', 'absent');
}

async function detectFeedbackLoop(ctx: Context): Promise<SdlcPlayResult> {
  const pkg = parseJson(await readCapped(ctx.root, 'package.json'));
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {};
  const make = (await readCapped(ctx.root, 'Makefile'))?.text ?? '';
  const hasTest = 'test' in scripts || /^test\s*:/m.test(make);
  const hasCheck = ['lint', 'typecheck', 'check', 'tsc'].some((k) => k in scripts) || /^(?:lint|check)\s*:/m.test(make);
  if (!hasTest && !hasCheck) return result('feedback-loop', 'absent');
  const evidence = Object.keys(scripts).length > 0 ? ['package.json'] : ['Makefile'];
  const verifyNamed = [ctx.claudeMd, ctx.agentsMd].some((t) => t && VERIFY.test(t.text));
  return hasTest && hasCheck && verifyNamed
    ? result('feedback-loop', 'present', evidence)
    : result('feedback-loop', 'partial', evidence, verifyNamed ? undefined : 'CLAUDE.md does not say how to verify');
}

async function detectConfigEvals(ctx: Context): Promise<SdlcPlayResult> {
  const evals = [
    ...(await listFiles(ctx.root, 'evals')).map((n) => `evals/${n}`),
    ...(await listFiles(ctx.root, '.claude/evals')).map((n) => `.claude/evals/${n}`),
  ];
  if (evals.length === 0) return result('config-evals', 'absent');
  const trigger = ctx.workflows.find((w) => /paths:[\s\S]{0,400}?(?:CLAUDE\.md|\.claude\/)/.test(w.text));
  return trigger
    ? result('config-evals', 'present', [...evals.slice(0, 3), trigger.path])
    : result('config-evals', 'partial', evals, 'no workflow runs the evals when CLAUDE.md or .claude/** changes');
}

async function detectAgentReview(ctx: Context): Promise<SdlcPlayResult> {
  const reviewMd = await exists(ctx.root, 'REVIEW.md');
  const action = ctx.workflows.find((w) => /claude-code-action/.test(w.text));
  const evidence = [...(reviewMd ? ['REVIEW.md'] : []), ...(action ? [action.path] : [])];
  if (reviewMd && action) return result('agent-review', 'present', evidence);
  if (reviewMd) return result('agent-review', 'partial', evidence, 'REVIEW.md without a CI review job');
  if (action) return result('agent-review', 'partial', evidence, 'review job without REVIEW.md');
  return result('agent-review', 'absent');
}

const GATE = /push|deploy|release|publish|secret|\.env|credential/i;

function detectApprovalGates(ctx: Context): SdlcPlayResult {
  const gating = hookGroups(ctx.settings, 'PreToolUse').some((g) => GATE.test(g.matcher) || g.commands.some((c) => GATE.test(c)));
  if (gating) return result('approval-gates', 'present', ['.claude/settings.json']);
  const anyHook = ctx.settings?.hooks && typeof ctx.settings.hooks === 'object' && Object.keys(ctx.settings.hooks).length > 0;
  return anyHook
    ? result('approval-gates', 'partial', ['.claude/settings.json'], 'hooks exist but none gate a push, deploy or secret')
    : result('approval-gates', 'absent');
}

function detectCiAgentJobs(ctx: Context): SdlcPlayResult {
  const jobs = ctx.workflows.filter(
    (w) => /claude\s+(?:-p|--print)\b/.test(w.text) || (/claude-code-action/.test(w.text) && !/review/i.test(w.path)),
  );
  return jobs.length > 0 ? result('ci-agent-jobs', 'present', jobs.map((w) => w.path)) : result('ci-agent-jobs', 'absent');
}

async function detectCloseTheLoop(ctx: Context): Promise<SdlcPlayResult> {
  const bands: string[] = [];
  for (const rel of ['bands.yaml', 'bands.yml', '.ai/bands.yaml', 'monitoring/bands.yaml']) {
    if (await exists(ctx.root, rel)) bands.push(rel);
  }
  if (bands.length === 0) return result('close-the-loop', 'absent');
  const scheduled = ctx.workflows.find((w) => /schedule:/.test(w.text) && /bands/.test(w.text));
  return scheduled
    ? result('close-the-loop', 'present', [...bands, scheduled.path])
    : result('close-the-loop', 'partial', bands, 'no scheduled job reads the bands');
}

function detectRecurringScans(ctx: Context): SdlcPlayResult {
  const scan = /codeql|security[- ]?(?:scan|review)|claude-code-security/i;
  const scans = ctx.workflows.filter((w) => scan.test(w.text));
  const scheduled = scans.filter((w) => /schedule:/.test(w.text));
  if (scheduled.length > 0) return result('recurring-scans', 'present', scheduled.map((w) => w.path));
  return scans.length > 0
    ? result('recurring-scans', 'partial', scans.map((w) => w.path), 'scan runs on events, not on a schedule')
    : result('recurring-scans', 'absent');
}

/** Score one project root. Never throws: a root that cannot be read is `missing`. */
export async function scanProject(root: string): Promise<ProjectScan> {
  try {
    if (!(await stat(root)).isDirectory()) return { status: 'missing', results: [] };
  } catch {
    return { status: 'missing', results: [] };
  }
  if (!(await exists(root, '.git'))) return { status: 'not-git', results: [] };

  const workflows: Context['workflows'] = [];
  for (const name of (await listFiles(root, '.github/workflows', /\.ya?ml$/i)).slice(0, MAX_WORKFLOWS)) {
    const path = `.github/workflows/${name}`;
    const text = await readCapped(root, path);
    if (text) workflows.push({ path, text: text.text });
  }
  const ctx: Context = {
    root,
    claudeMd: await readCapped(root, 'CLAUDE.md'),
    agentsMd: await readCapped(root, 'AGENTS.md'),
    settings: parseJson(await readCapped(root, '.claude/settings.json')),
    workflows,
    intentFiles: await markdownIn(root, ['intent', '.ai/intent']),
  };

  const byPlay = new Map<SdlcPlayId, SdlcPlayResult>();
  for (const r of await Promise.all([
    detectIntent(ctx),
    detectSpec(ctx),
    detectPlan(ctx),
    detectClaudeMd(ctx),
    detectSkills(ctx),
    detectBuildHooks(ctx),
    detectSubagents(ctx),
    detectFeedbackLoop(ctx),
    detectConfigEvals(ctx),
    detectAgentReview(ctx),
    detectApprovalGates(ctx),
    detectCiAgentJobs(ctx),
    detectCloseTheLoop(ctx),
    detectRecurringScans(ctx),
  ])) {
    byPlay.set(r.play, r);
  }
  // Catalog order, so the answer is stable however the detectors resolve.
  return { status: 'ok', results: PLAYS.flatMap((p) => byPlay.get(p.id) ?? []) };
}
