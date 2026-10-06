# REVIEW.md

How an agent (or a person) reviews a pull request in this repository.

## Passes

1. **Correctness**: does the change do what the linked intent/spec/issue asks, including the failure paths?
2. **Security**: untrusted input, secrets, authorization, injection, unsafe shell or file access.
3. **Conformance**: does the diff match the plan or spec it claims to implement? Flag unrelated changes.

## Severity

- **Important**: a bug, a security problem, a broken contract, or a missing test for new behavior. Blocks merge.
- **Nit**: style, naming, small clarity. Never blocks. Report at most five nits per review.

## Do not comment on

- Formatting a formatter already enforces.
- Pre-existing problems the diff does not touch (file a follow-up instead).
- Taste differences with no stated rule behind them.

## Author and approver

The agent that wrote a change does not approve or merge it. A human does, after a separate reviewer has looked.
The `.claude/hooks/guard-merge.mjs` hook blocks an agent from running `gh pr merge` or `gh pr review --approve`.

A separate reviewer can be a person or an agent that is not the author: cezar's built-in `pr-review` workflow
reviews a pull request, posts one comment sorted into Important and Nit, and has no way to approve or merge.
Prefer a different agent backend or model than the one that wrote the change.
