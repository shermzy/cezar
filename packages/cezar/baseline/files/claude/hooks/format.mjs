#!/usr/bin/env node
// PostToolUse formatter (cezar SDLC baseline). Formats ONLY the file the agent just wrote, and only
// when the repository already has Prettier installed. Never blocks: every failure path exits 0.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const file = event?.tool_input?.file_path;
if (typeof file !== 'string' || !/\.(?:[cm]?[jt]sx?|json|css|scss|md|ya?ml|html)$/i.test(file)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
if (!existsSync(bin) || !existsSync(file)) process.exit(0);

spawnSync(bin, ['--write', '--log-level', 'silent', file], { cwd: root, timeout: 10_000, stdio: 'ignore', shell: process.platform === 'win32' });
process.exit(0);
