import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fetchGithubDelivery } from '../../../packages/cezar/src/server/forge/github.ts';

// Read-only transport smoke. This changes no PR, check, repository setting or issue.
const repository = { host: 'github.com', owner: 'open-mercato', repo: 'cezar' };
const url = 'https://github.com/open-mercato/cezar/pull/1290';
const result = await fetchGithubDelivery(process.cwd(), repository, [{ number: 1290, url }]);
assert.equal(result.available, true, result.reason);
assert.equal(result.prs[0]?.url, url);
assert.equal(result.prs[0]?.state, 'merged');
assert.equal(result.prs[0]?.mergeCommitSha, '02634469333fa565d3a7a1ce50a723fbb40c344d');
assert.ok(result.checks.length > 0, 'Expected target-branch push workflow evidence');
assert.notEqual(result.truncated, true, 'Transport evidence must be complete');
for (const check of result.checks) {
  assert.equal(check.sha, result.prs[0].mergeCommitSha);
  assert.equal(check.branch, result.prs[0].baseRef);
  assert.equal(check.event, 'push');
  assert.match(check.url, /^https:\/\/github\.com\/open-mercato\/cezar\/actions\/runs\//);
}
const wrong = await fetchGithubDelivery(process.cwd(), repository, [{ number: 1290, url: 'https://github.com/shermzy/cezar/pull/1290' }]);
assert.equal(wrong.available, false, 'A PR URL in another repository must be refused');
writeFileSync('.ai/qa/delivery/live-read.json', JSON.stringify({ checkedAt: new Date().toISOString(), result, wrongRepositoryRejected: true }, null, 2));
console.log(JSON.stringify({ passed: true, pr: url, mergedSha: result.prs[0].mergeCommitSha, workflowRuns: result.checks.length, truncated: result.truncated ?? false }));
