import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRepo, githubAttempts, githubFallbackAfterError, isGithubSearchFailure, isListingQuery,
} from '../src/github-robust.ts';

test('extractRepo depuis query repo:owner/name', () => {
  assert.deepEqual(extractRepo({ query: 'repo:facebook/react is:issue' }), { owner: 'facebook', repo: 'react' });
  assert.deepEqual(extractRepo({ owner: 'acme', repo: 'api' }), { owner: 'acme', repo: 'api' });
});

test('isListingQuery : qualifiers purs vs NL', () => {
  assert.equal(isListingQuery('repo:facebook/react is:issue'), true);
  assert.equal(isListingQuery('repo:facebook/react is:pr is:merged'), true);
  assert.equal(isListingQuery('memory leak in concurrent mode'), false);
  assert.equal(isListingQuery(''), true);
});

test('search_issues listing → list_issues en premier', () => {
  const a = githubAttempts('github__search_issues', { query: 'repo:facebook/react is:issue', perPage: 100 });
  assert.equal(a[0]!.tool, 'github__list_issues');
  assert.equal(a[0]!.args.owner, 'facebook');
  assert.equal(a[0]!.args.repo, 'react');
  assert.equal(a[0]!.args.state, 'OPEN');
  assert.ok((a[0]!.args.perPage as number) <= 30);
  assert.equal(a.length, 1, 'pas de search NL inutile');
});

test('search_issues NL + repo → list puis search', () => {
  const a = githubAttempts('github__search_issues', { owner: 'facebook', repo: 'react', query: 'concurrent rendering bug', perPage: 50 });
  assert.equal(a[0]!.name, 'list_issues');
  assert.ok(a.some((x) => x.name === 'search_issues'));
});

test('search_pull_requests → list_pull_requests', () => {
  const a = githubAttempts('github__search_pull_requests', { query: 'repo:facebook/react is:pr is:merged' });
  assert.equal(a[0]!.tool, 'github__list_pull_requests');
  assert.equal(a[0]!.args.state, 'closed');
});

test('fallback après 422', () => {
  const fb = githubFallbackAfterError(
    'github__search_issues',
    { query: 'repo:facebook/react is:issue' },
    'failed to search issues: 422 Validation Failed cannot be searched',
  );
  assert.ok(fb);
  assert.equal(fb!.tool, 'github__list_issues');
});

test('isGithubSearchFailure', () => {
  assert.ok(isGithubSearchFailure('failed to search issues: search_type=semantic: 422 Validation Failed'));
  assert.ok(!isGithubSearchFailure({ issues: [] }));
  // Un SHA ou un JSON valide qui contient « 422 » n'est pas une erreur de search.
  assert.ok(!isGithubSearchFailure({ commits: [{ sha: 'b618bbb4422693bbb8d387180687b3f' }] }));
  assert.ok(!isGithubSearchFailure('[{"sha":"b618bbb44226"}]'));
});
