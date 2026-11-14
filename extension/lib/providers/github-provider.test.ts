import assert from 'node:assert/strict';
import { buildBehindQuery, firstUnresolvedThreadUrl, nextPageSize, readBehindCounts } from './github-provider';

// Sizing the request to the count probe is what keeps a 7-PR user from being billed like a 100-PR one,
// so the arithmetic gets a check. Run with: npm test
function testNextPageSize(): void {
	// Small view: one page sized exactly, no rounding up to the max.
	assert.equal(nextPageSize(7, 0), 7);

	// Empty view still floors at 1 — GraphQL rejects `first: 0`. Callers skip the request entirely.
	assert.equal(nextPageSize(0, 0), 1);

	// Large view: clamped to GitHub's per-page maximum.
	assert.equal(nextPageSize(250, 0), 100);

	// Later pages ask only for the remainder, so the last page of 250 costs half a full page.
	assert.equal(nextPageSize(250, 100), 100);
	assert.equal(nextPageSize(250, 200), 50);

	// Drift: PRs closed between the probe and the fetch can push seen past the count. Still never 0.
	assert.equal(nextPageSize(10, 12), 1);
}

testNextPageSize();

// The "Changes Requested (N)" link must land on a thread the count actually includes — resolved and
// outdated threads must never win, even when they come first. Run with: npm test
function testFirstUnresolvedThreadUrl(): void {
	const resolved = { isResolved: true, isOutdated: false, comments: { nodes: [{ url: 'resolved', createdAt: '2026-01-01T00:00:00Z' }] } };
	const outdated = { isResolved: false, isOutdated: true, comments: { nodes: [{ url: 'outdated', createdAt: '2026-01-02T00:00:00Z' }] } };
	const open = { isResolved: false, isOutdated: false, comments: { nodes: [{ url: 'open', createdAt: '2026-01-03T00:00:00Z' }] } };

	// Resolved and outdated threads are skipped even when listed before the open one.
	assert.equal(firstUnresolvedThreadUrl([resolved, outdated, open]), 'open');

	// No open thread: nothing to link to.
	assert.equal(firstUnresolvedThreadUrl([resolved, outdated]), undefined);

	// GitHub's array order isn't chronological: the later-created open thread appears first in the
	// array, but the earlier-created one must still win.
	const openLater = { isResolved: false, isOutdated: false, comments: { nodes: [{ url: 'later', createdAt: '2026-01-05T00:00:00Z' }] } };
	const openEarlier = {
		isResolved: false,
		isOutdated: false,
		comments: { nodes: [{ url: 'earlier', createdAt: '2026-01-04T00:00:00Z' }] },
	};
	assert.equal(firstUnresolvedThreadUrl([openLater, openEarlier]), 'earlier');

	// Empty thread list.
	assert.equal(firstUnresolvedThreadUrl([]), undefined);
}

testFirstUnresolvedThreadUrl();

function testBehindCounts(): void {
	const targets = [
		{ id: 'github-A', owner: 'o', name: 'r', base: 'main', headOid: 'abc' },
		{ id: 'github-B', owner: 'o2', name: 'r2', base: 'dev', headOid: 'def' },
	];
	const { query, variables } = buildBehindQuery(targets);
	assert.match(query, /p0: repository\(owner: \$o0, name: \$n0\)/);
	assert.match(query, /p1: repository/);
	assert.deepEqual(variables, { o0: 'o', n0: 'r', b0: 'main', h0: 'abc', o1: 'o2', n1: 'r2', b1: 'dev', h1: 'def' });

	// Unreadable repo, missing base ref and failed compare all leave the count off rather than showing 0.
	const counts = readBehindCounts(targets, { rateLimit: null, p0: { ref: { compare: { behindBy: 0 } } }, p1: { ref: null } });
	assert.equal(counts.get('github-A'), 0);
	assert.equal(counts.has('github-B'), false);
}

testBehindCounts();
console.log('github-provider: all checks passed');
