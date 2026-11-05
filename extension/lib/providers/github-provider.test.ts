import assert from 'node:assert/strict';
import { buildReviews, firstUnresolvedThreadUrl, nextPageSize } from './github-provider';

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
// Review status, modelled on a real PR: a code-quality bot approved it four times, a team's review was
// still requested, and GitHub said REVIEW_REQUIRED. It used to read as approved. Run with: bun run test
function testReviewStatus(): void {
	type ReviewInput = Parameters<typeof buildReviews>[0];
	const review = (login: string, state: string, typename = 'User') => ({
		databaseId: 1,
		state,
		author: { login, avatarUrl: '', __typename: typename },
	});
	const pr = (overrides: Partial<ReviewInput>): ReviewInput =>
		({ reviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, ...overrides }) as ReviewInput;

	const botApprovals = { nodes: [review('codescene-access', 'APPROVED', 'Bot'), review('codescene-access', 'APPROVED', 'Bot')] };
	const teamRequest = { nodes: [{ requestedReviewer: { __typename: 'Team' } }] };

	// GitHub's own decision wins, whatever the reviews look like.
	assert.equal(
		buildReviews(pr({ reviews: botApprovals, reviewRequests: teamRequest, reviewDecision: 'REVIEW_REQUIRED' })).status,
		'pending',
	);
	assert.equal(buildReviews(pr({ reviews: botApprovals, reviewDecision: 'APPROVED' })).status, 'approved');
	assert.equal(buildReviews(pr({ reviewDecision: 'CHANGES_REQUESTED' })).status, 'changes_requested');

	// No decision (no review required): bots don't count as reviewers, and a team request is still pending.
	const botsOnly = buildReviews(pr({ reviews: botApprovals, reviewDecision: null }));
	assert.equal(botsOnly.status, 'pending');
	assert.deepEqual(botsOnly.reviewers, []);
	assert.equal(buildReviews(pr({ reviews: { nodes: [review('ada', 'APPROVED')] }, reviewRequests: teamRequest })).status, 'pending');

	// A person's approval with nothing outstanding still reads as approved.
	assert.equal(
		buildReviews(pr({ reviews: { nodes: [review('ada', 'APPROVED'), review('bot', 'APPROVED', 'Bot')] } })).status,
		'approved',
	);

	// Team requests stay out of `pendingReviewers`, which notifications match against the viewer's login.
	const mixed = { nodes: [{ requestedReviewer: { __typename: 'User', login: 'ada' } }, { requestedReviewer: { __typename: 'Team' } }] };
	assert.deepEqual(buildReviews(pr({ reviewRequests: mixed })).pendingReviewers, ['ada']);
}

testReviewStatus();
console.log('github-provider: all checks passed');
