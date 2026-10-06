#!/usr/bin/env node
// PreToolUse guard for Bash (cezar SDLC baseline v2). An agent that wrote a pull request does not
// merge or approve it: a human does. This blocks the ways an agent could do either through the
// GitHub CLI. Exit 2 blocks the tool call and shows stderr to the agent; anything else lets it
// through. Fast, no dependencies, and it fails OPEN on unreadable input so a broken hook can never
// wedge a session.
//
// It reads commands the way a shell would, enough to tell a CALL from a MENTION: the text of a
// commit message or a PR comment may legitimately contain "gh pr merge", and quoted text is one
// token, never a command.
import { readFileSync } from 'node:fs';

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (event?.tool_name && event.tool_name !== 'Bash') process.exit(0);
const command = event?.tool_input?.command;
if (typeof command !== 'string' || command.length === 0) process.exit(0);

/** Split a command line into simple commands, each a list of unquoted-word tokens. */
function simpleCommands(line) {
  const commands = [];
  let tokens = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) tokens.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      endCommand();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'env', 'nohup', 'nice']);
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

function block(why) {
  process.stderr.write(`Blocked by .claude/hooks/guard-merge.mjs: ${why} An agent does not merge or approve pull requests; ask a human to.\n`);
  process.exit(2);
}

for (const tokens of simpleCommands(command)) {
  let i = 0;
  while (i < tokens.length && (WRAPPERS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  if (tokens[i] !== 'gh') continue;
  const args = tokens.slice(i + 1);
  // Positional words only: drop flags, and the value of the flags that take one (-R owner/repo).
  const positional = [];
  for (let j = 0; j < args.length; j++) {
    if (GH_VALUE_FLAGS.has(args[j])) j++;
    else if (!args[j].startsWith('-')) positional.push(args[j]);
  }
  if (positional[0] === 'pr' && positional[1] === 'merge') block('`gh pr merge` merges a pull request.');
  if (positional[0] === 'pr' && positional[1] === 'review' && args.some((a) => a === '--approve' || a === '-a')) {
    block('`gh pr review --approve` approves a pull request.');
  }
  if (positional[0] === 'api') {
    const joined = args.join(' ');
    if (/\/pulls\/\d+\/merge\b/.test(joined) || /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(joined)) {
      block('this `gh api` call merges a pull request.');
    }
    if (/\bAPPROVE\b/.test(joined) && /(?:\/reviews\b|PullRequestReview)/.test(joined)) {
      block('this `gh api` call approves a pull request.');
    }
  }
}
process.exit(0);
