# SDLC fleet audit and baseline - verification record

Spec: `.ai/specs/2026-10-06-ai-native-sdlc-fleet.md`. Everything below is repeatable from a built checkout
(`npm run build`) and touches only temp directories.

## 1. Adopt the baseline into a fresh repo (real built CLI)

```bash
T=$(mktemp -d) && git init -q "$T"
echo '{"scripts":{"test":"vitest","typecheck":"tsc"}}' > "$T/package.json"
node packages/cezar/dist/index.js sdlc baseline plan  --into "$T"   # 7 x create, writes nothing
node packages/cezar/dist/index.js sdlc baseline apply --into "$T"   # 7 x wrote
node packages/cezar/dist/index.js sdlc baseline apply --into "$T"   # 7 x skip-current, "nothing to write"
```

Observed 2026-10-06: first apply wrote `CLAUDE.md`, `.claude/settings.json`, `.claude/hooks/guard-secrets.mjs`,
`.claude/hooks/format.mjs`, `REVIEW.md`, `intent/README.md`, `intent/TEMPLATE.md` and
`.claude/cezar-baseline.json`; the second apply wrote nothing. `{{test}}`/`{{lint}}` were filled from
`package.json` (`npm test`, `npm run typecheck`).

## 2. The shipped guard hook blocks, as a real process

```bash
echo '{"tool_input":{"file_path":"/x/.env"}}' | node "$T/.claude/hooks/guard-secrets.mjs"; echo $?
```

Observed: `Blocked by .claude/hooks/guard-secrets.mjs: /x/.env holds credentials. ...` and exit `2`.

## 3. The audit moves

```bash
node -e "import('./packages/cezar/dist/sdlc/scan.js').then(async m => { const r = await m.scanProject(process.argv[1]); console.log(r.status, r.results.map(x => x.play + ':' + x.score).join(' ')) })" "$T"
```

| Play | Bare repo | After adopt |
| --- | --- | --- |
| claude-md | absent | present |
| build-hooks | absent | present |
| approval-gates | absent | present |
| feedback-loop | partial (scripts only) | present |
| intent | absent | partial (template only) |
| agent-review | absent | partial (REVIEW.md, no CI job) |

Run against this repository itself the audit reports `claude-md: partial` (AGENTS.md only),
`build-hooks: absent`, `agent-review: absent`, `recurring-scans: present` (scheduled CodeQL) - the same
findings as the manual audit in `docs/audits/ai-native-sdlc-2026-10-06.md`.

## 4. Automated suites

```bash
npm test -- packages/cezar/src/sdlc packages/cezar/src/server/sdlc-api \
  packages/cezar/src/server/contract-parity.sdlc packages/cezar/src/pack-check packages/web/src/routes/dashboard/sdlc
npm run typecheck && npm run build
```

Observed: scan, baseline (including real hook child processes) and cli suites, the api and contract-parity
suites, and the web matrix suite all pass; typecheck is clean; build and `check:pack` are ok (baseline files
are present in the tarball).

## Not covered here

- `npm run test:e2e` (real-browser UI, needs agent-browser) and `npm run test:package` were not run.
- The adoption task end to end through a live cockpit (queue, worktree, review gate) was not run: the
  workspace registry rejects Windows roots, so no project can be registered on the machine this was built on.
  The pieces are covered separately: the route and in-flight rule (`sdlc-api.test.ts`), the check-step command
  (built CLI above), and the workflow runner's check-step path (existing suites).
- `npm test` across the whole repo has many pre-existing failures on Windows (registry roots, bash, file modes);
  the files touched by this work were compared against a run without the change and add none.

## 5. Phase 3: upgrading an adopted repo from baseline v1 to v2 (real built CLI)

Repeats section 1 with the phase 1-2 bundle as an override, edits one file, then applies the built-in v2:

```bash
T=$(mktemp -d); H=$(mktemp -d); git init -q "$T"; echo '{"scripts":{"test":"vitest","typecheck":"tsc"}}' > "$T/package.json"
mkdir -p "$H/sdlc-baseline" && git archive 3379547d packages/cezar/baseline | tar -x -C "$H/sdlc-baseline" --strip-components=3
CEZ_HOME="$H" node packages/cezar/dist/index.js sdlc baseline apply --into "$T"     # v1
echo "// my edit" >> "$T/.claude/hooks/format.mjs"
node packages/cezar/dist/index.js sdlc baseline plan  --into "$T"                  # v1 -> v2
node packages/cezar/dist/index.js sdlc baseline apply --into "$T"
```

Observed 2026-10-06: the plan updates `.claude/settings.json` and `REVIEW.md`, creates `.claude/hooks/guard-merge.mjs`,
leaves `.claude/hooks/format.mjs` alone as `skip-diverged` (the edited file), and reports every other file
`skip-current`. A second plan is all `skip-current`. `guard-merge.mjs` exits 2 on `gh pr merge 5` and 0 on
`gh pr view 5` and on `git commit -m "explain gh pr merge"`.

This run found a real bug before it shipped: on a Windows checkout the bundle is CRLF, so the first attempt reported
`update` for files whose text had not changed. Hashes now normalise line endings (`baseline.test.ts`, "line endings
never decide whether a file was edited"; red before the fix, green after).

Not run: a live `pr-review` task against a real pull request (needs an agent login and a GitHub PR).
