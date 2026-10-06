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

The agent that wrote a change does not approve it. A human or a separate reviewer approves.
