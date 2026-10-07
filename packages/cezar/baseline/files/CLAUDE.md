# CLAUDE.md

Keep this under one page. When a mistake happens twice, add it to "Things Claude gets wrong here".

## Verifying your work

Run these before reporting a change as done, and say what you ran:

- Tests: `{{test}}`
- Lint / typecheck: `{{lint}}`

Fix the cause of a failure; do not edit a test to make it pass unless the test itself is wrong.

## Working here

- Make a plan before touching code on anything larger than a one-file fix; write it down (files, order, risks, how you will prove it works).
- Prefer the smallest change that solves the stated problem.
- Never commit secrets, `.env` files or credentials. The hooks in `.claude/` block most of these; do not work around them.
- Do not hand-edit lockfiles; regenerate them with the package manager.

## Things Claude gets wrong here

<!-- One line each, with the file or command involved. Empty on purpose until it happens. -->
