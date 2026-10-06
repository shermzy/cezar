# Delivery tracking verification

Issue: https://github.com/shermzy/cezar/issues/3

Scope: the first delivery increment, implemented and independently reviewed by Luna. Explicit
tracking observes PR merges and GitHub Actions push workflows for the exact merged SHA and
target branch. CI success refers to the workflows observed, not branch-policy completeness,
release, deployment, or business acceptance. No merge or release was performed.

## Verified

- Full `npm run typecheck` passed across contract, client, server, and cockpit after review fixes.
- Focused delivery, API, contract, typed-body, versioned-surface, and route-inventory checks:
  32 assertions across six files. The failure scenarios were authored before implementation.
- Review fixes cover legacy marker associations, immediate stale invalidation after authoritative
  association changes, deletion during refresh, and a first failed observation without a stale
  badge. Prior evidence retains its original repository when the current forge is unavailable.
- The stale-repository assertion failed before its fix, then passed with the fix.
- Production build and `check:pack` passed; the tarball includes the built cockpit.
- Read-only GitHub transport verification passed for upstream PR 1290, merge SHA
  `02634469333fa565d3a7a1ce50a723fbb40c344d`, and two target-branch push workflows.
  A PR URL for a different repository was refused. See [live-read.json](live-read.json).

## Limits

The full Windows gate was attempted and is **not green**:

| Command | Result on this host |
| --- | --- |
| `npm test` | 418 files passed, 100 failed, 2 skipped; 8168 tests passed, 575 failed, 32 skipped; one unhandled error |
| `npm run test:unit` | 33 passed, 2 failed, 1 skipped; POSIX `mkdir` and `/bin/sh` cannot spawn |
| `npm run test:package` | 16 passed, 1 failed; packaged CLI test cannot spawn `npm.cmd` (`EINVAL`) |
| Additional route-parity checks | Four failures involving project registration/fixture cleanup on Windows |
| Delivery browser E2E | Blocked: native browser daemon launch/read timeouts and host paging-memory exhaustion; no passing screenshot evidence |

These counts include unrelated, untouched test areas. They are not evidence that every failure
is a baseline failure; a clean supported-host CI run and browser QA remain required before merge.
The provisional browser-provider workaround was removed, so the shared harness remains intact.

## Repeatable checks

From the repository root after `npm ci`:

```sh
npm run typecheck
npm test -- --maxWorkers=2 packages/cezar/src/delivery/service.test.ts packages/cezar/src/server/delivery-api.test.ts packages/cezar/src/server/contract-parity.runs.test.ts packages/cezar/src/server/typed-bodies.test.ts packages/cezar/src/server/versioned-surface.test.ts packages/cezar/src/server/bc-route-inventory.test.ts
npm run build
node --import tsx .ai/qa/delivery/live-read.mjs
npm run test:e2e
```

The live-read script requires an authenticated `gh` session and makes read-only calls. The browser
spec uses the existing agent-browser provider, starts its own isolated fixture, and verifies its
server process identity before shutdown. It covers persisted evidence, explicit tracking, stale
evidence, legacy markers, keyboard activation, narrow layout, and dark theme.
For an isolated rerun once the provider descriptor has been provisioned, use
`npm test -- --config packages/web/e2e/vitest.config.ts delivery.e2e.ts`.

Task-owned runtime metadata and raw logs were kept locally rather than committed. Scoped browser
sessions were closed through the browser CLI. Recorded task process trees were audited after
cleanup; the original checkout and its unrelated changes were preserved.
