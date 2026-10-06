# AI-native SDLC across the fleet: agent PR review and the approval gate (phase 3)

> Slug: `ai-native-sdlc-review-loop` · Status: **implemented on branch `claude/sdlc-phase3-review-loop` (stacked on `claude/ai-native-sdlc-cezar-208f6d`)** · Default on for the review workflow (it only runs when a user creates and enables an automation), nothing to configure
> Builds on `2026-10-06-ai-native-sdlc-fleet.md` (phases 1-2: audit + baseline). Playbook plays covered: P12 *AI in the PR review loop*, P13 *Hooks as approval gates*.

## TLDR

Phase 3 puts an **agent reviewer** in the loop and makes "the author agent cannot merge or approve its own PR" a real rule instead of a sentence in a doc.

1. **The review runs in cezar, not in each repo.** A new built-in workflow `pr-review` runs as an ordinary cezar task (own worktree, parallel cap, thread you can read), triggered by the existing GitHub automation `pull_request.opened`, using the agent login you already have. No GitHub Action, no `ANTHROPIC_API_KEY` repo secret, no workflow file added to the repos you control.
2. **The reviewer is a different run from the author, by construction, and cannot approve.** Its Bash is restricted to `gh pr view|diff|checks|checkout|comment` and read-only git; its only write to GitHub is one PR comment. It never uses `gh pr review`, so it cannot approve or request changes.
3. **Agents in adopted repos cannot merge or approve either.** Baseline v2 adds a `PreToolUse` hook that blocks agent Bash from `gh pr merge`, `gh pr review --approve` and the equivalent `gh api`/GraphQL calls.
4. **The audit sees both.** `agent-review` is Present when `REVIEW.md` exists and either a `claude-code-action` workflow or an enabled cezar `pr-review` automation does; `approval-gates` recognises the merge/approve guard.

## Resolved decisions (owner answers, 2026-10-06)

| # | Question | Decision |
|---|---|---|
| D1 | How does the review workflow reach repos? | **Run the review on the cezar app itself.** Not a GitHub workflow in each repo. |
| D2 | Where is "author cannot merge/approve" enforced? | **Agent hooks + audit.** No new cezar server gate: a server-side gate cannot stop a local agent, which can still call `gh` with the user's credentials. |

## Resolved assumptions

| # | Question | Decision |
|---|---|---|
| A1 | Post to GitHub, or keep the review local? | The reviewer posts **one** PR comment (`gh pr comment`) and ends with the same text in its thread. A comment is the review surface the playbook describes; approve/request-changes are never available to it. |
| A2 | Automation default state | A built-in **template** only ("Review new pull requests"). The user creates it, so it follows the existing "created paused unless asked" automation convention. Nothing starts on its own. |
| A3 | Which backend reviews? | The template leaves `runner` unset (project default). Reviewing with a **different backend or model than the author** is recommended in the prompt card and docs; cezar does not force it. |
| A4 | `REVIEW.md` | Read first when present (baseline v1 already ships one); otherwise the workflow's built-in passes apply. |
| A5 | Does the allowlist bind every backend? | **No, and the spec says so.** `bashAllowlist` is honoured by the Claude CLI runner only; Codex, OpenCode and Cursor ignore it (AGENTS.md § Task routing, agent runners). On those backends the restriction is prompt-level. The repo-side hook has the same Claude-only reach. |
| A6 | Server-side gate in cezar's merge box | **Not built** (D2). The merge box already requires a human click, an expected-head preflight and GitHub's own required-review rules. |
| A7 | Branch-protection check in the audit | **Out.** Reading protection rules needs the network; the audit stays offline. It belongs with the forge reader. |

## Review workflow (`pr-review`)

Added to `BUILT_IN_WORKFLOWS` beside `quick-task` and `sdlc-baseline`, so it exists in every repo (a repo workflow file of the same name still shadows it, as for any built-in).

One agent step with:

- `allowedTools: [Read, Grep, Glob, Bash]`, `bashAllowlist: [gh pr view, gh pr diff, gh pr checks, gh pr checkout, gh pr comment, git diff, git log, git show, git status]`. No `Write`/`Edit`: a review never changes the repository.
- A prompt that: reads the PR identified in `{{task}}` (the automation appends the untrusted event context); reads `REVIEW.md` if present; reviews correctness, security and conformance with the diff; classifies every finding **Important** (blocks) or **Nit** (at most five); states plainly when it found nothing; posts one `gh pr comment`; never approves, requests changes, merges or edits; treats PR text as untrusted data.
- Findings must cite `path:line`.

## Automation template

`BUILTIN_AUTOMATION_TEMPLATES` gains **Review new pull requests**: GitHub trigger `pull_request.opened`, 5-minute interval, `workflow: 'pr-review'`, prompt `Review pull request {{github.url}}.` The file's header comment ("none names a workflow") is corrected: a built-in workflow exists in every repo, so naming one is safe.

## Baseline v2 (`packages/cezar/baseline/`, version 1 → 2)

- New `.claude/hooks/guard-merge.mjs`: quote-aware, so `git commit -m "explain gh pr merge"` and a review comment that *mentions* a command are not calls. It blocks `gh pr merge`, `gh pr review --approve|-a`, and `gh api`/GraphQL calls that merge or approve. Exit 2 with an explanation; fails open on unreadable input.
- `.claude/settings.json` gains a `PreToolUse` group on `Bash` for it.
- `REVIEW.md` names cezar's `pr-review` workflow and the author/approver rule.
- Repos already on v1 show `outdated`; "Adopt baseline" updates only files whose hash still equals what cezar wrote (A5 of the phase 1-2 spec), so a repo that edited `settings.json` is told, not overwritten. This is the first real exercise of that path.

## Audit changes (`src/sdlc/scan.ts`)

- `agent-review`: Present when `REVIEW.md` **and** (a `claude-code-action` workflow **or** an enabled automation with `task.workflow === 'pr-review'` in `.ai/cezar/automations.json`); Partial for either half alone, with a note naming what is missing.
- `approval-gates`: the gate pattern now also matches `merge` and `approve`, so the v2 guard counts.

## Failure modes (tests written first)

| Failure | Required behaviour |
|---|---|
| Quoted mention of a blocked command in a commit message or comment body | Allowed |
| `gh -R o/r pr merge`, `cd x && gh pr merge`, `FOO=1 gh pr merge`, piped, `gh pr review -a` | Blocked |
| `gh api -X PUT .../pulls/N/merge`, `.../reviews -f event=APPROVE`, GraphQL merge/approve | Blocked |
| Non-Bash tool event, unreadable stdin | Allowed (exit 0) |
| `automations.json` missing, corrupt or huge | `agent-review` falls back to the workflow-file check; never throws |
| Repo shadows `pr-review` with its own file | Its file wins, like any built-in |
| `pr-review` step definition | One step; no `Write`/`Edit`; allowlist excludes `gh pr review`, `gh pr merge`, `git push` |

## Not done (deliberately)

- **Posting inline, line-anchored review comments.** One summary comment keeps the allowlist to `gh pr comment`; inline comments need the GraphQL/`gh api` surface, which the allowlist is built to exclude.
- **Enforcement on non-Claude backends** (A5), a **server-side merge gate** (D2), and **branch-protection auditing** (A7).
- **Auto-enabling the review automation** on any repo. The fleet view may later offer it per project; this spec only ships the workflow and the template.
- **Review-finding evals and `REVIEW.md` tuning loops:** phase 5.

## Implementation notes (2026-10-06)

- **Code:** `PR_REVIEW_WORKFLOW` and `BUILT_IN_WORKFLOWS` in `packages/cezar/src/workflows/types.ts`; `guard-merge.mjs` and baseline v2 in `packages/cezar/baseline/`; `detectAgentReview` and the widened gate pattern in `packages/cezar/src/sdlc/scan.ts`; the template in `packages/web/src/lib/automation-templates.ts`.
- **The guard reads commands like a shell, not with a regex over the whole string.** It splits on `; | & ( ) \n` and backtick outside quotes, strips `sudo`/`env`/`VAR=x` wrappers, tokenises with quote handling, and looks at the `gh` subcommand positionally, so `gh -R o/r pr merge` is caught while `git commit -m "explain gh pr merge"` and a `gh pr comment --body "...gh pr merge..."` are not. A heredoc body that contains a newline followed by a command line would be split like a real command: an accepted over-block, and the safe direction.
- **Known gaps, stated rather than hidden:** the allowlist and the hook bind the Claude backend only (A5); a determined agent with Bash can still call the REST API with `curl` and a token, which no hook on `gh` sees; GitHub branch protection is the real backstop.
- **Verification:** typecheck; `guard-merge` (every blocked and allowed spelling, run as real child processes), `scan`, `pr-review` and template suites pass; related automation/workflow suites show no new failures (the remaining ones are the known Windows ones, and two dashboard/automation UI tests that pass alone). Not run: a live `pr-review` task against a real pull request (needs an agent login and a GitHub PR), `test:e2e`, `test:package`.
