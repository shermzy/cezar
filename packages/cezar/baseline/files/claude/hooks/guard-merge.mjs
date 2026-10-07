#!/usr/bin/env node
// PreToolUse guard for Bash (cezar SDLC baseline). An agent that wrote a pull request should not
// merge or approve it: a human does. This catches common GitHub CLI invocations, but shell scripts,
// other clients and non-Claude backends need GitHub-side permissions as the real boundary.
// Exit 2 blocks the tool call and shows stderr to the agent; anything else lets it
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
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const executableName = (token) => token?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '');
function isPowerShellCommandOption(arg) {
  const option = arg.toLowerCase();
  return option === '-c' || option === '-cwa' ||
    (option.length >= 3 && ['-command', '-commandwithargs'].some((name) => name.startsWith(option)));
}

function block(why) {
  process.stderr.write(`Blocked by .claude/hooks/guard-merge.mjs: ${why} An agent does not merge or approve pull requests; ask a human to.\n`);
  process.exit(2);
}

/** Shell substitutions execute even inside double-quoted comment text. */
function substitutions(line) {
  const found = [];
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (c === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue; }
    if (c === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; continue; }
    if (quote !== "'" && c === '`') {
      const start = i + 1;
      let j = start;
      for (; j < line.length; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '`') break;
      }
      if (j < line.length) found.push(line.slice(start, j));
      i = j;
      continue;
    }
    if (quote === "'" || c !== '$' || line[i + 1] !== '(') continue;
    const start = i + 2;
    let depth = 1;
    let innerQuote = null;
    let j = start;
    for (; j < line.length; j++) {
      const inner = line[j];
      if (inner === '\\' && innerQuote !== "'") { j++; continue; }
      if (inner === "'" && innerQuote !== '"') { innerQuote = innerQuote === "'" ? null : "'"; continue; }
      if (inner === '"' && innerQuote !== "'") { innerQuote = innerQuote === '"' ? null : '"'; continue; }
      if (innerQuote) continue;
      if (inner === '(') depth++;
      else if (inner === ')' && --depth === 0) break;
    }
    if (depth === 0) found.push(line.slice(start, j));
    i = j;
  }
  return found;
}

/** Skip only wrapper options whose argument count is known; opaque forms are denied. */
function unwrap(tokens) {
  let i = 0;
  while (i < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { i++; continue; }
    const wrapper = executableName(tokens[i]);
    if (!WRAPPERS.has(wrapper)) break;
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const option = tokens[i];
      if (option === '--') { i++; break; }
      if (wrapper === 'env' && (option === '-S' || /^-S.+/.test(option) || option === '--split-string' || option.startsWith('--split-string='))) {
        return { why: 'an `env` split-string command cannot be checked safely.' };
      }
      const noValue = {
        env: ['-i', '--ignore-environment'],
        sudo: ['-n', '-E', '-H', '-S', '-k', '-b', '-i', '-s'],
        command: ['-p'],
        exec: ['-c', '-l'],
        time: ['-p', '--portability'],
        nice: [],
        nohup: [],
      }[wrapper];
      const withValue = {
        env: ['-u', '--unset', '-C', '--chdir'],
        sudo: ['-u', '--user', '-g', '--group'],
        command: [],
        exec: ['-a'],
        time: ['-f', '--format', '-o', '--output'],
        nice: ['-n', '--adjustment'],
        nohup: [],
      }[wrapper];
      if (noValue.includes(option)) { i++; continue; }
      if (withValue.includes(option)) {
        if (i + 1 >= tokens.length) return { why: `an incomplete ${wrapper} option cannot be checked safely.` };
        i += 2;
        continue;
      }
      if ((wrapper === 'env' && (/^(?:-u.|--unset=|--chdir=)/.test(option))) ||
          (wrapper === 'sudo' && (/^(?:-u.|--user=|-g.|--group=)/.test(option))) ||
          (wrapper === 'nice' && (/^(?:-n.+|--adjustment=)/.test(option))) ||
          (wrapper === 'time' && (/^(?:-f.+|--format=|-o.+|--output=)/.test(option)))) {
        i++;
        continue;
      }
      return { why: `an unsupported ${wrapper} option cannot be checked safely.` };
    }
  }
  return { index: i };
}

function denial(line, depth = 0) {
  if (depth > 4) return 'nested shell commands cannot be checked safely.';
  for (const nested of substitutions(line)) {
    const why = denial(nested, depth + 1);
    if (why) return why;
  }
  for (const tokens of simpleCommands(line)) {
    const unwrapped = unwrap(tokens);
    if (unwrapped.why) return unwrapped.why;
    const i = unwrapped.index;
    const executable = executableName(tokens[i]);
    if (SHELLS.has(executable)) {
      const args = tokens.slice(i + 1);
      if ((executable === 'powershell' || executable === 'pwsh') && args.some((arg) => {
        const option = arg.split(/[:=]/, 1)[0].toLowerCase();
        return option.length > 1 && option.startsWith('-') &&
          (option === '-ec' || '-encodedcommand'.startsWith(option) || '-encodedarguments'.startsWith(option));
      })) return 'an encoded PowerShell command cannot be checked safely.';
      const commandOption = args.findIndex((arg) => executable === 'cmd'
        ? /^\/[ck]$/i.test(arg)
        : executable === 'powershell' || executable === 'pwsh'
          ? isPowerShellCommandOption(arg)
          : /^-[a-z]*c[a-z]*$/.test(arg) || arg === '--command');
      if (commandOption >= 0 && args[commandOption + 1]) {
        const nested = executable === 'cmd' || executable === 'powershell' || executable === 'pwsh'
          ? args.slice(commandOption + 1).join(' ')
          : args[commandOption + 1];
        const why = denial(nested, depth + 1);
        if (why) return why;
      }
    }
    if (executable !== 'gh') continue;
    const args = tokens.slice(i + 1);
    // Positional words only: drop flags, and the value of the flags that take one (-R owner/repo).
    const positional = [];
    for (let j = 0; j < args.length; j++) {
      if (GH_VALUE_FLAGS.has(args[j])) j++;
      else if (!args[j].startsWith('-')) positional.push(args[j]);
    }
    if (positional[0] === 'pr' && positional[1] === 'merge') return '`gh pr merge` merges a pull request.';
    if (positional[0] === 'pr' && positional[1] === 'review' && args.some((a) => a === '--approve' || a === '-a')) {
      return '`gh pr review --approve` approves a pull request.';
    }
    if (positional[0] === 'api') {
      const joined = args.join(' ');
      if (/\/pulls\/\d+\/merge\b/.test(joined) || /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(joined)) {
        return 'this `gh api` call merges a pull request.';
      }
      if (/\bAPPROVE\b/.test(joined) && /(?:\/reviews\b|PullRequestReview)/.test(joined)) {
        return 'this `gh api` call approves a pull request.';
      }
    }
  }
  return null;
}

const why = denial(command);
if (why) block(why);
process.exit(0);
