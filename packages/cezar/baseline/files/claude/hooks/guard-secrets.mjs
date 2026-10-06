#!/usr/bin/env node
// PreToolUse guard (cezar SDLC baseline). Blocks an agent edit that would write a secret or touch
// a file that must not be hand-edited. Exit 2 blocks the tool call and shows stderr to the agent;
// anything else lets it through. Fast, no dependencies, and it fails OPEN on unreadable input so a
// broken hook can never wedge a session.
import { readFileSync } from 'node:fs';

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const input = event?.tool_input ?? {};
const path = String(input.file_path ?? input.path ?? '').replaceAll('\\', '/');
const content = [input.content, input.new_string, ...(Array.isArray(input.edits) ? input.edits.map((e) => e?.new_string) : [])]
  .filter((v) => typeof v === 'string')
  .join('\n');

const block = (why) => {
  process.stderr.write(`Blocked by .claude/hooks/guard-secrets.mjs: ${why}\n`);
  process.exit(2);
};

const SECRET_FILE = /(^|\/)(\.env(\.[\w.-]+)?|[\w.-]*\.pem|[\w.-]*\.p12|id_(rsa|ed25519|ecdsa)|credentials\.json|\.npmrc|\.aws\/credentials)$/i;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/i;
if (path && SECRET_FILE.test(path) && !ENV_EXAMPLE.test(path)) {
  block(`${path} holds credentials. Reference the secret by name from the environment or the team's secret store instead of writing it into the repository.`);
}

const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/;
if (path && LOCKFILE.test(path)) {
  block(`${path} is generated. Change the manifest and regenerate the lockfile with the package manager.`);
}

const SECRET_VALUE = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'a private key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'a GitHub token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];
for (const [pattern, what] of SECRET_VALUE) {
  if (pattern.test(content)) block(`the new content contains ${what}. Remove it and read it from the environment at runtime.`);
}

process.exit(0);
