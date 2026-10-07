# AI-native SDLC across the fleet — audit and baseline (phases 1–2)

> Slug: `ai-native-sdlc-fleet` · Status: **implemented on branch `claude/ai-native-sdlc-cezar-208f6d`, uncommitted** · Default on, nothing to configure
> Source: Anthropic "AI-native SDLC playbook" (six stages; every stage commits an artifact the next stage reads).
> Companion audit of this repo: `docs/audits/ai-native-sdlc-2026-10-06.md`.
> Phases 3–5 (agent PR review job, breach→`intent.md` automations, config evals) are a follow-up spec; § Not done lists what this spec leaves for them.

## TLDR

cezar already hosts N registered projects in one process (`2026-07-20-multi-project-workspace`). This spec makes it the **control plane for the AI-native SDLC across those repos**, in two read-then-write steps:

1. **Fleet audit.** A deterministic, agent-free, read-only scan scores every registered project against the playbook's plays (Absent / Partial / Present, with file evidence) and shows a project × play matrix in a new **SDLC** dashboard tab. Zero cost, no network, no setup.
2. **Baseline adoption.** cezar ships a versioned **SDLC baseline** (CLAUDE.md, build-time hooks, `REVIEW.md`, an `intent/` template). "Adopt baseline" creates one ordinary cezar task per selected repo that writes the missing files into the task's worktree and stops at the **review gate**. A human reads the diff and pushes a draft PR through the existing `gh` flow. A repo never receives a baseline without a human-approved PR, and an existing file is never modified.

The repo owns its copy afterwards. cezar is not needed for the repo to keep working; it only knows how to *offer* the next baseline version.

## Why this shape

- **Detection is code, not an agent** (playbook principle 3). The audit reads files and counts evidence. An LLM scoring 30 repos would be slow, costly, non-repeatable and a new always-on cost surface, which AGENTS.md § Zero config forbids as a default.
- **Artifacts live in each repo's git history** (principle 1: one named source of truth). cezar holds the policy and the scoreboard, not the repos' state. Delete `~/.cezar` and every adopted repo still works.
- **The existing task path is the write path.** Worktree isolation, `maxParallel`/memory admission, the review gate, "never auto-merge", draft PR via `gh`: all of it already exists and is already the safety story. A bespoke "push files to N repos" mechanism would be a second, less-reviewed one.
- **Advisory vs enforced** (principle 2): the baseline's value is its hooks, because AGENTS.md-style prose is advisory. Phase 2 ships the enforcing layer; the audit makes its absence visible.

## Resolved assumptions

| # | Question | Decision |
|---|---|---|
| A1 | Agent or deterministic audit? | **Deterministic.** File presence + bounded content checks. An optional agent-written narrative report (as in the repo audit) is a later workflow, not this spec. |
| A2 | Flag? | **None.** The scan is local, read-only, bounded and runs only while the SDLC tab is open (demand-driven, like the dashboard). No env var → no `.env.example` change. Baseline *apply* is an explicit button, never automatic. |
| A3 | Where does the baseline live? | Built in: `packages/cezar/baseline/`, shipped in the tarball. **Override by discovery**: if `~/.cezar/sdlc-baseline/` exists it is used instead (state written never required; absent = built-in). No settings screen. |
| A4 | Overwrite existing repo files? | **Never.** Create-if-absent only. A file that exists and differs is reported `diverged` and left alone. |
| A5 | Resync when the baseline version bumps? | Yes, but only for files whose hash still equals what cezar wrote (tracked in the repo's `.claude/cezar-baseline.json`). Untouched → updated in the PR; edited → left alone, reported. |
| A6 | Who opens the PR? | The existing draft-PR button after the review gate. This spec adds no new push path. |
| A7 | Autonomy tiers (observe/propose/act) | **Out.** Phase 2 only ever *proposes* (a task ending at review). Tiers arrive with phase 4. |
| A8 | Which plays are scored? | Those detectable from files: see § Play catalog. Auto mode (P7) and on-call (P17) are not file-detectable and are not scored. |
| A10 | P2 and policy skills | P2 scores on intent + spec presence only. A missing policy skill is a `note` on the cell and counts against P5, not twice. |
| A11 | Baseline hooks | **Working hooks ship in the baseline** (secret/lockfile guard on PreToolUse, format on PostToolUse), not a stub. |
| A9 | Git-derived indicators (first-pass CI rate, intent→spec gap)? | **Out.** Phase 1 shows only the signals already in cezar's run store; PR/CI-derived indicators need the forge reader and a baseline period. |

## Play catalog (phase 1)

Static table in `packages/cezar/src/sdlc/plays.ts`: id, stage, title, prerequisite ids, detector. The prerequisite graph drives the "next move" hint per repo (the unmet play with the most dependents whose own prerequisites are met).

Detector rules are file checks on the project root. Reads are capped at 64 KB per file, no tree walk beyond the fixed globs, symlinks that leave the root are not followed, YAML is text-matched, not parsed (a malformed workflow must not break the scan).

| Play | Present when | Partial when |
|---|---|---|
| P1 intent.md | `intent/*.md` (or `.ai/intent/*.md`) with ≥1 file carrying a status line | folder or template only |
| P2 spec | `spec.md` / `specs/` / `.ai/specs/` next to ≥1 intent | specs without any intent |
| P3 plan | `plan.md` / `.ai/plans/` with ≥1 file | none, but a plan-mode hint in CLAUDE.md |
| P4 CLAUDE.md | `CLAUDE.md` ≤ 150 lines and mentions a test/verify command | exists but longer, or only `AGENTS.md` |
| P5 skills | `.claude/skills/*/SKILL.md` or `.ai/skills/*` with ≥2 skills | exactly 1 |
| P6 build hooks | `.claude/settings.json` with `PreToolUse` **and** `PostToolUse` entries | one of the two |
| P8 subagents | `.claude/agents/*.md` with ≥1 file | none (worktrees alone do not count) |
| P10 feedback loop | `package.json` (or Makefile) defines test **and** lint/typecheck, **and** CLAUDE.md names how to verify | scripts only |
| P11 config evals | `evals/` (or `.claude/evals/`) **and** a workflow whose `paths:` includes `CLAUDE.md` or `.claude/**` | evals dir only |
| P12 agent review | `REVIEW.md` **and** a workflow referencing `claude-code-action` | `REVIEW.md` only |
| P13 approval gates | a hook with `permissionDecision`/exit-2 on a PreToolUse matcher for a push/deploy/secret pattern | settings with hooks, none gating |
| P14 CI agent jobs | a workflow invoking `claude -p` or the action in a non-review job | none |
| P15 close the loop | `bands.yaml` (or equivalent) **and** a scheduled workflow/automation referencing it | file only |
| P16 recurring scans | a `schedule:` workflow running CodeQL/Claude security | scan on push only |

Each result carries `evidence: string[]` (repo-relative paths, at most 5) and an optional one-line `note` ("CLAUDE.md is 212 lines"). A cell is explainable from its evidence alone.

## Contract (`packages/contract/src/sdlc.ts`)

One zod schema per shape, types inferred. Re-exported through the api-client. Bounds on every array and string.

- `sdlcPlayIdSchema` (enum), `sdlcScoreSchema` (`absent | partial | present`).
- `sdlcPlaySchema` `{ id, stage, title, prereqs: id[] }` — the catalog travels with the answer so the cockpit never hard-codes it.
- `sdlcPlayResultSchema` `{ play, score, evidence, note? }`.
- `sdlcBaselineStateSchema` `none | current | outdated | diverged` with `version?` and per-file entries `{ path, state: untouched|diverged|missing }`.
- `sdlcProjectAuditSchema` `{ projectId, name, status: ok|missing|not-git, scannedAt, results[], baseline, next? }`.
- `sdlcAuditSchema` `{ baselineVersion, plays[], projects[] }`.
- Apply: `sdlcBaselineRequestSchema` `{ projectIds: string[1..50] }`; `sdlcBaselinePlanSchema` `{ projects: [{ projectId, files: [{ path, action: create|update|skip-diverged|skip-current }] }] }`; `sdlcBaselineApplySchema` `{ runs: [{ projectId, runId } | { projectId, error }] }`.

Optional keys that may be absent are spread conditionally, not set to `undefined` (AGENTS.md § The HTTP API).

## Server (`packages/cezar/src/sdlc/`, `src/server/sdlc.ts`)

- `plays.ts` (catalog), `scan.ts` (pure: `scanProject(root) → ProjectAudit`, no I/O outside bounded reads), `baseline.ts` (load bundle, hash, plan, apply-into-directory).
- `SdlcReader` mirrors `DashboardReader`: reads registered projects from the workspace registry, **60 s TTL cache per project keyed on a cheap identity** (mtime of the handful of probed paths), dispose on registry change. A `missing` root is reported, never scanned. Task worktrees are not projects (`shouldRegisterProject`) and are never scanned.
- Routes, chained into one family builder, validated through the trio, workspace-level single-mount like `/dashboard` and `/projects` (never under `/api/v1/p/`):
  - `GET /api/v1/workspace/sdlc/audit` → `sdlcAuditSchema`.
  - `POST /api/v1/workspace/sdlc/baseline/plan` → `sdlcBaselinePlanSchema` (computes, writes nothing).
  - `POST /api/v1/workspace/sdlc/baseline/apply` → `sdlcBaselineApplySchema`.
- Add the three routes to the `BACKWARD_COMPATIBILITY.md` §2 inventory in the same commit; `bc-route-inventory`, `versioned-surface` and `typed-bodies` fail otherwise.
- The existing request-origin guard covers CSRF. The audit exposes only repo-relative evidence paths plus the project root already exposed by `/projects`; nothing new about file contents beyond a bounded `note` string.

## Baseline bundle (`packages/cezar/baseline/`)

Versioned by one integer in `baseline/manifest.json` (`version`, file list). Initial contents, all repo-neutral and short:

| File | Purpose |
|---|---|
| `CLAUDE.md` | ≤ 1 page: how to verify (placeholders the operator fills: `{{test}}`, `{{lint}}`), "things Claude gets wrong here" block left empty with the rule *a mistake made twice goes here*, `@AGENTS.md` import if one exists |
| `.claude/settings.json` | Hook wiring only (PreToolUse secret/lockfile guard, PostToolUse format hook). No permissions, no MCP, no network |
| `.claude/hooks/*.mjs` | The hook scripts. Node only, file-scoped, fast, each prints an explanatory message on block |
| `REVIEW.md` | Passes (correctness, security, spec/plan conformance), **Important vs Nit**, nit cap, exclusions |
| `intent/TEMPLATE.md`, `intent/README.md` | Author, date, status (`proposed/accepted/rejected`), problem, outcome, affected systems, constraints |
| `.claude/cezar-baseline.json` | Written by apply: `{ version, files: { path: sha256 } }`. This is what makes resync safe |

`apply` into a directory is deterministic and idempotent: running it twice produces an empty diff. It substitutes `{{test}}`/`{{lint}}` from `package.json` scripts when found and leaves the literal placeholder (flagged in the PR body) when not. It never reads secrets and writes only inside the target directory.

## Adoption flow (reuses the task path)

1. SDLC tab → select repos → **Adopt baseline** → dialog shows the plan per repo (files created / updated / skipped-diverged) from `/baseline/plan`. Nothing is written yet.
2. Confirm → `/baseline/apply` creates **one ordinary task per project** using a new built-in workflow `sdlc-baseline`: step 1 is a **check step** (`node "$CEZ_BIN" sdlc baseline apply --into .`, no agent, no tokens; check steps run `bash -lc` in the worktree with the server's environment, and `serveCommand` sets `CEZ_BIN` in `index.ts`, so the cockpit's own binary is used, never a stale `cez` on PATH. A headless `cezar run` has no `CEZ_BIN`, so the workflow is cockpit-only), then the standard review gate. Each task is isolated in its worktree, queued behind the workspace `maxParallel`/memory admission, and ends at **review**.
3. The reviewer reads the diff in the cockpit, pushes a draft PR with the existing button. cezar never merges.
4. Next scan, the repo shows `baseline: current`. When `baselineVersion` increases, repos still on the old version show `outdated` and can be re-run; edited files are left alone and listed as `diverged`.

A failed apply (bad worktree, no write access) is an ordinary failed task. The audit is unaffected.

## Cockpit (`packages/web/src/routes/dashboard/sdlc.tsx`)

- New **SDLC** tab beside Overview / Costs / Automations: project rows × play columns, grouped by stage; cells are Present/Partial/Absent chips, click → evidence list and note. Per-row "next move" hint and a baseline chip. Header: fleet-wide coverage per play.
- Filter by project tag (existing `normalizeProjectTags`), export through the existing export menu.
- Missing/not-git projects are shown greyed, not omitted. Remote mode: read-only; the apply button is hidden unless the server reports local handoff capability (same guard as agent-config writes).
- Subscribes nowhere live: it fetches on open and on explicit refresh (the scan is cached; no WebSocket topic, no `refetchInterval`).

## Failure modes (written first, tested first)

| Failure | Required behaviour |
|---|---|
| Registered root deleted / not git | Row shows `missing` / `not-git`; no throw; other rows unaffected |
| Unreadable file, permission denied, 5 MB `CLAUDE.md` | That detector degrades to Absent with a `note`; read capped at 64 KB; scan completes |
| Malformed `settings.json` / workflow YAML | Score from text match or Absent; never crash, never a 500 |
| Symlink pointing outside the repo | Not followed |
| 50 repos at once | Scan is bounded per project and cached; apply is 50 queued tasks, the semaphore admits them, the UI shows queued |
| Apply twice | Second plan says `skip-current`; no task diff |
| Target file exists and differs | `skip-diverged`; PR body lists it; file untouched |
| Two apply requests race on one project | Second gets the existing run (idempotent per project+version), not a duplicate task |
| `~/.cezar/sdlc-baseline/` present but invalid | Warn once, fall back to built-in; never block boot |
| `gh` absent / offline | Task still ends at review in the worktree; draft PR step degrades as it already does |

## Zero-config and compatibility check

- **Default path with every knob at its shipped value:** audit works with no setup; apply is an explicit action. Nothing is required, nothing writes state outside the task worktree and the in-memory cache.
- **No network, no new process, no new env var.** AGENTS.md § Zero config satisfied; no `.env.example` change.
- **Additive only:** three new routes, one new built-in workflow (verified: `loadWorkflows` re-adds the hard-coded built-in list on every load unless a repo workflow file of the same name shadows it, so adding `sdlc-baseline` is one array entry in `workflows/load.ts` plus its definition beside `QUICK_TASK_WORKFLOW` in `workflows/types.ts`; the `quick-task` fallback in `server/server.ts` is unaffected), one new tarball directory. No existing mechanism is replaced, so § Changing a mechanism that already works does not apply.
- **Packaging:** `baseline/` must be listed in the `cezar` package `files` and covered by `check:pack` / `test:package`; the contract is inlined by `postbuild` as today.

## Verification

Per the repo's gate, plus real fixtures instead of mocks:

- **Fixture repos** built in a temp dir by the test (not committed): bare repo, repo with a long CLAUDE.md, repo with only `AGENTS.md`, repo with hooks but no gate, fully adopted repo, malformed settings, symlink-out. Assertions are on `scanProject` scores and evidence for each, written from the failure table before the detectors.
- `contract-parity.sdlc.test.ts` (both directions), `typed-bodies` entry, route inventory, `route-parity` untouched (workspace-level routes are single-mount).
- **Idempotence golden:** `apply` into an empty dir, then again → empty `git diff`; apply into a repo with an edited `CLAUDE.md` → that file byte-identical afterward.
- **E2E (`CEZ_DRY_RUN=1`, `npm run test:e2e`):** register two throwaway repos, open the SDLC tab, run Adopt on one, drive the task to review, assert the worktree diff contains exactly the planned files and the matrix updates to `baseline: current` after the (locally simulated) merge. Leave the repeatable artifact at `.ai/qa/sdlc-fleet.md` with the commands and the observed matrix, like `host-telemetry-conformance.md`.
- Full gate: `typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.

## Delivery

One PR to `main`, phased for review:

1. Contract + play catalog + `scan.ts` + fixtures (red first) + `/sdlc/audit`.
2. SDLC tab (matrix, evidence sheet, export).
3. Baseline bundle + `baseline.ts` + `cez sdlc baseline apply` + `/baseline/plan`.
4. `sdlc-baseline` built-in workflow + `/baseline/apply` + adopt dialog + E2E + docs (`docs/reference.md` route/CLI entries, README one-liner, CHANGELOG).

## Not done (deliberately)

- **Agent review job and the author-cannot-approve rule** (P12/P13 enforcement in cezar's own merge path): phase 3.
- **Breach → `intent.md` automations, `bands.yaml` runner, autonomy tiers:** phase 4.
- **Config evals before a baseline rollout:** phase 5. Until then the baseline is validated by the fixture and E2E checks above, not by agent-behaviour evals, and that gap is real: a baseline hook that misfires on a real repo is caught only by the human reading the PR.
- **Git/PR-derived indicators** (first-pass CI rate, time to review, intent→spec gap): needs a baseline window and the forge reader.
- **Automatic or scheduled baseline sync, auto-merge, writing to non-registered repos:** no. Every write is an operator click ending at a review gate.
- **Per-repo baseline customization UI:** override is the `~/.cezar/sdlc-baseline/` directory only.

## Open questions

None outstanding. Settled 2026-10-06: hooks ship working (A11), P2 scores on intent + spec presence (A10), the manifest lives at `.claude/cezar-baseline.json`.

## Implementation notes (2026-10-06)

Where the built thing differs from, or adds to, the text above:

- **Routes live under `/workspace/sdlc/...`**, beside `/workspace/dashboard`, not `/sdlc/...`.
- **Code:** `packages/contract/src/sdlc.ts`; `packages/cezar/src/sdlc/{plays,scan,baseline,reader,adopt,cli}.ts`; `src/server/sdlc.ts`; the baseline bundle in `packages/cezar/baseline/` (shipped through the package `files` list and enforced by `check:pack`); the cockpit in `packages/web/src/routes/dashboard/sdlc*.tsx` and `src/api/sdlc.ts`. The SDLC tab is a fourth Dashboard view (`?view=sdlc`).
- **`startAdoption` is its own module**, so the "one in flight per project" rule is unit-tested without a server. The in-flight check matches the `sdlc-baseline` workflow in `queued/running/waiting/review`, so a task parked at the review gate blocks a duplicate until it is finished or cancelled.
- **The baseline file state `created` was dropped** from the contract: it described an apply outcome, not a state a scan can observe.
- **`SDLC_BASELINE_WORKFLOW` is a second entry in a new `BUILT_IN_WORKFLOWS` list** (`workflows/types.ts`), which `loadWorkflows` re-adds on every load unless a repo file of the same name shadows it. Adoption uses the built-in definition directly, never the shadowing file.
- **Hooks shipped:** `guard-secrets.mjs` blocks writes to `.env*`, key files, lockfiles, and content containing an AWS/GitHub/Anthropic/Slack token or a private key, and fails open on unreadable input. `format.mjs` runs Prettier on the one edited file only when the repo already has it, and never blocks. Both are exercised as real child processes in `baseline.test.ts`; writing that test caught a real escaping bug in the first draft of the guard.
- **Known platform limit, not caused by this work:** the workspace registry schema accepts only POSIX-absolute roots (`workspace/config.ts`, `startsWith('/')`), so on Windows no project can be registered and the SDLC tab, like every other registry-backed view, shows none. The route tests inject the project list instead of using the registry.
- **Verification actually run:** typecheck, the new vitest suites (scan, baseline, cli, sdlc-api, contract-parity, pack-check, web matrix), `npm run build` including `check:pack`, and a real run of the built CLI; see `.ai/qa/sdlc-fleet.md`. Not run: `npm run test:e2e` (needs agent-browser) and `npm run test:package`.
- **Baseline v2 (phase 3)** adds `.claude/hooks/guard-merge.mjs` and its `PreToolUse` Bash wiring; see `2026-10-06-ai-native-sdlc-review-loop.md`. Repos adopted at v1 report `outdated` and resync only the files they have not edited.
