# AI-native SDLC audit — cezar (2026-10-06)

Source: Anthropic "AI-native SDLC playbook" (six stages; each stage commits an artifact the next reads).
Evidence is from this worktree at `47cc6e1d`. Scores: Present / Partial / Absent.

## Verdict

cezar already runs a stronger *ticket-to-merge* pipeline than the playbook assumes (labels, claim protocol, QA gate, `om-*` skills, a thorough AGENTS.md, 200+ dated specs). What it lacks is the **two ends of the loop** and the **enforcement layer**: nothing captures intent before a spec, nothing turns production signals back into work, and every rule that matters lives in prose (skills/AGENTS.md) with no hook or CI check behind it. There is also no `.claude/` directory at all — no hooks, no subagents, no repo-scoped settings.

cezar is also the *tool* that executes this loop, so there are two application tracks: (A) run cezar's own repo this way, (B) make the cezar product express the loop natively. B is where the leverage is.

## Stage table

| Stage / play | Score | Evidence |
|---|---|---|
| 1 Plan — P1 intent.md | Absent | No `intent/`. Work enters as a GitHub issue or free-form brief (`SDLC.md` "Intake"). Specs in `.ai/specs/` are design docs, not intent. |
| 2 Design — P2 spec in one session | Partial | `.ai/specs/` (dated, cited from code comments) is a real spec habit. No policy-as-skill constraining specs; no intent→spec trigger. |
| 3 Build — P3 plan mode / plan.md | Partial | `.ai/plans/`, `docs/superpowers/plans/`, `.ai/WORKLIST.md`; `om-auto-create-pr` plans per phase. Not one consistent per-change artifact; WORKLIST.md is stale (2026-07-16). |
| P4 CLAUDE.md | Partial | `AGENTS.md` is excellent but ~200 dense lines (playbook: under a page). No `CLAUDE.md` pointer, so Claude Code sessions may not load it by name. |
| P5 Skills | Partial | `.ai/skills/om-prepare-test-env` only; the rest are externally installed `om-*`. No named policy owner per skill. |
| P6 Build hooks | Absent | No `.claude/settings.json`. Rules like "never `npx vitest`", "`.env.example` in the same commit as a `CEZ_*` change", "route via chained builder" are prose-only. |
| P8 Parallel / subagents | Partial | Worktrees are the product core; dispatch engine caps 4 children. No `.claude/agents/*` (verifier, simplifier). |
| 4 Test — P9/10 feedback loop | Present | One gate in `agentic.config.json`; `test:e2e` + `CEZ_DRY_RUN=1`; contract-parity tests. Missing: hook blocking test-file edits during fixes. |
| P11 Evals on config | Absent | No suite that regression-tests AGENTS.md / skills / workflows. Unit tests cover code, not agent behavior. |
| 5 Deploy — P12 PR review loop | Partial | `CODE_REVIEW.md` + `om-auto-review-pr` (local). No `claude-code-action` in `.github/workflows`; no `REVIEW.md` with Important-vs-Nit and nit cap (CODE_REVIEW.md is close — rename/convert). |
| P13 Approval-gate hooks | Partial | Gates exist (QA gate, `do-not-merge`, claim protocol) but enforced by skill honesty, not a hook/branch-protection. Playbook principle 2 violated. |
| P14 CI/CD agent jobs | Partial | CI/nightly/release/codeql solid; no `claude -p` triage of failed builds or changelog. |
| 6 Maintain — P15 close the loop | Absent | Automations (`src/automations/`: schedule + GitHub/tracker pollers, default-on) are exactly the trigger layer, but no detection→`intent.md` flow and no `bands.yaml`. |
| P16 Recurring scans | Partial | `codeql.yml`; no scheduled agent security scan with dismissal log. |
| P17 Claude on call | Absent | n/a for a local tool; the equivalent is issue triage from user reports. |

Where cezar already exceeds the playbook: label state machine with exclusivity, claim protocol for concurrent agents, risk/priority inference rules, explicit "name what the old mechanism was load-bearing for" change discipline, run-history evidence (`.ai/runs`), BACKWARD_COMPATIBILITY inventory test.

## Top gaps, by leverage

1. **Enforce what is only advised (P6 + P13).** Highest leverage, no prerequisites, and every other play leans on it. Today a Claude session can run `npx vitest`, add a `CEZ_*` var without `.env.example`, or write a loose `app.get()` and nothing stops it until review.
2. **Intent + spec chain (P1 → P2).** Add `intent.md` as the artifact that precedes `.ai/specs/`. Specs already exist; intent gives them a provenance and an accept/reject record.
3. **Config evals (P11).** AGENTS.md is the product's steering file and keeps growing; nothing proves a change to it still produces correct agent behavior.
4. **Close the loop (P15) via cezar's own automations.** The poller/scheduler exists; only the detection rule and the intent-writing prompt are missing.
5. **Agent PR review in CI (P12).** Wire `REVIEW.md` into an Actions job; keep author≠approver.

## Next three moves (concrete)

1. **`.claude/settings.json` + `.claude/hooks/`** (S, no prerequisites). PreToolUse hooks that: block `npx vitest`; block edits to `packages/cezar/src/server/*.test.ts`-style contract-parity tests while fixing a bug; warn on a `CEZ_*` diff without `.env.example`; PostToolUse `tsc --noEmit` scoped to touched package. Add `CLAUDE.md` containing `@AGENTS.md` plus a ≤20-line "things Claude gets wrong here" block (the `ActiveRun` two-construction-sites bug, the stale local `main` diff base, the loose route).
2. **`intent/` + `/intent` skill** (S). `intent/<date>-<slug>.md` with author, status (proposed/accepted/rejected), problem, outcome, affected systems, constraints. Update `SDLC.md` Intake to say "an accepted intent file or a ticket linking one". Make `.ai/specs/*` reference their intent. Add a one-line `plan.md` convention (`.ai/plans/<date>-<slug>.md`: files, order, risks, proof) and retire `.ai/WORKLIST.md`.
3. **`evals/` seeded from past incidents** (M). 20 real tasks (#810, #811, the `ActiveRun` case, `POST /runs` untyped body…) each as prompt + deterministic check, run via `CEZ_DRY_RUN`-style fixtures or a recorded-transcript harness; CI job triggered on changes to `AGENTS.md`, `.claude/**`, `.ai/skills/**`. Only worth running once move 1 exists.

## Product track (cezar as the loop runner)

Cezar's own bundled workflows could ship the chain as built-ins, which is the more distinctive application:
- A built-in `intent → spec → plan → build` workflow whose steps each commit their artifact and whose review gate is the existing diff gate (never auto-merges — already matches principle 4).
- An automation template "breach → intent.md": a scheduled check (CI red on main, nightly failure, error-rate file) runs deterministically, and only on breach dispatches a task that writes an `intent.md` PR. Reuses `automations/` and `dispatch/`; stays zero-config because it ships OFF-by-default only as an *enabled automation the user creates*, consistent with the 2026-09-14 exception.
- Respect AGENTS.md § Zero config: none of this needs a required config file; hooks and evals are repo-dev tooling, not user-facing state.

## Caveats

- Not verified: whether `om-*` skills (installed outside the repo) already enforce parts of this; I scored what is committed.
- AGENTS.md's own rule — "when a feature seems to need configuration, the design is wrong" — means track B should be tried as built-in workflow/template first, not settings.
- Indicators (first-pass CI rate, intent→spec gap) are readable from git/PR data but I did not compute baselines.
