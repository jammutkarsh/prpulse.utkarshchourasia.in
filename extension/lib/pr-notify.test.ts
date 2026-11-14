import assert from 'node:assert/strict';
import { notificationsFor, isStaleCache, DASHBOARD_URL } from './pr-notify';
import type { PullRequest, PullRequestData } from './types';

// The rules that decide whether you get interrupted. Every case here is one that would otherwise
// notify wrongly — a silent first run, an already-reviewed PR, a rollup appearing out of nowhere.
// Run with: npm test

const LAST_FETCH = Date.parse('2026-02-01T12:00:00Z');
const OLD = '2026-01-01T00:00:00Z';
const FRESH = '2026-02-01T12:05:00Z';

function pr(overrides: Partial<PullRequest> & { id: string }): PullRequest {
	return {
		provider: 'github',
		number: 1,
		title: 'title',
		url: `https://github.com/acme/api/pull/${overrides.number ?? 1}`,
		repoFullName: 'acme/api',
		repoOwner: { login: 'acme', type: 'org' },
		branchName: 'feat/thing',
		author: { login: 'ada', name: 'Ada', avatarUrl: '' },
		state: 'open',
		changes: { additions: 0, deletions: 0, filesChanged: 0 },
		checks: { status: 'unknown' },
		reviews: { status: 'pending', reviewers: [] },
		createdAt: OLD,
		updatedAt: OLD,
		isDraft: false,
		...overrides,
	};
}

function data(overrides: Partial<PullRequestData> = {}): PullRequestData {
	return { myPRs: [], reviewRequests: [], lastFetched: LAST_FETCH, ...overrides };
}

function requested(id: string, overrides: Partial<PullRequest> = {}): PullRequest {
	return pr({ id, reviews: { status: 'pending', reviewers: [], pendingReviewers: ['me'] }, ...overrides });
}

/** The third line Chrome draws under the message: how big the PR is, not which PR it is. */
function testDiffSizeRidesAlong(): void {
	const requestedPr = requested('1', { changes: { additions: 30, deletions: 40, filesChanged: 3 } });

	assert.equal(notificationsFor(data(), data({ reviewRequests: [requestedPr] }), 'me')[0].detail, '+30 −40 · 3 files');

	const singleFile = requested('2', { changes: { additions: 1, deletions: 0, filesChanged: 1 } });
	assert.equal(notificationsFor(data(), data({ reviewRequests: [singleFile] }), 'me')[0].detail, '+1 −0 · 1 file');

	// A group spans several PRs, so there is no one size to report.
	const many = ['3', '4'].map((id) => requested(id));
	assert.equal(notificationsFor(data(), data({ reviewRequests: many }), 'me', new Map(), true)[0].detail, undefined);
}

function testFirstRunIsSilent(): void {
	const next = data({ reviewRequests: [requested('1')], myPRs: [pr({ id: '2' })] });

	// No prior snapshot means no diff — otherwise a fresh install announces every open PR at once.
	assert.deepEqual(notificationsFor(data({ lastFetched: null }), next, 'me'), []);
	// Same for a poll that runs before the user identity is known: `pendingReviewers` is unmatchable.
	assert.deepEqual(notificationsFor(data(), next, ''), []);
}

function testReviewRequestNeedsAnOutstandingAsk(): void {
	// The provider merges `reviewed-by:@me` into reviewRequests, so a PR arriving in that list is not
	// automatically a request: without `me` in pendingReviewers it is one you already reviewed.
	const alreadyReviewed = pr({ id: '1', reviews: { status: 'pending', reviewers: [], pendingReviewers: ['someone-else'] } });
	assert.deepEqual(notificationsFor(data(), data({ reviewRequests: [alreadyReviewed] }), 'me'), []);

	// Already on screen at the last poll — not news either.
	const known = requested('1');
	assert.deepEqual(notificationsFor(data({ reviewRequests: [known] }), data({ reviewRequests: [known] }), 'me'), []);
}

function testReviewRequestWording(): void {
	const [fresh] = notificationsFor(data(), data({ reviewRequests: [requested('1', { createdAt: FRESH })] }), 'me');
	assert.equal(fresh.kind, 'review_requested');
	assert.equal(fresh.title, 'acme/api #1');
	assert.match(fresh.message, /opened a PR for your review/);

	const [existing] = notificationsFor(data(), data({ reviewRequests: [requested('1')] }), 'me');
	assert.match(existing.message, /requested your review/, 'a PR older than the last poll is an addition, not a new PR');
}

function testSeparateByDefault(): void {
	const three = [requested('1', { number: 1 }), requested('2', { number: 2 }), requested('3', { number: 3 })];
	const specs = notificationsFor(data(), data({ reviewRequests: three }), 'me');

	assert.deepEqual(
		specs.map((spec) => spec.title),
		['acme/api #1', 'acme/api #2', 'acme/api #3'],
	);
	// Distinct ids, or the OS would replace one with the next instead of showing all three.
	assert.equal(new Set(specs.map((spec) => spec.id)).size, 3);
}

function testGroupingCollapsesOneKind(): void {
	const sameRepo = [requested('1', { number: 1 }), requested('2', { number: 2 }), requested('3', { number: 3 })];
	const [grouped] = notificationsFor(data(), data({ reviewRequests: sameRepo }), 'me', new Map(), true);

	assert.equal(grouped.title, '3 PRs need your review');
	assert.equal(grouped.message, 'in acme/api');
	assert.equal(grouped.url, DASHBOARD_URL, 'a grouped notification has no single PR to open');

	// One author across several repos is still a useful detail, so it beats the bare repo count.
	const oneAuthor = sameRepo.map((entry, index) => ({ ...entry, repoFullName: `acme/repo-${index}` }));
	assert.equal(notificationsFor(data(), data({ reviewRequests: oneAuthor }), 'me', new Map(), true)[0].message, 'from @ada');

	// Nothing in common: the count is all there is to say.
	const spread = oneAuthor.map((entry, index) => ({ ...entry, author: { login: `dev-${index}`, name: '', avatarUrl: '' } }));
	assert.equal(notificationsFor(data(), data({ reviewRequests: spread }), 'me', new Map(), true)[0].message, 'across 3 repos');
}

function testReviewVerdictsOnMyPRs(): void {
	const mine = pr({ id: '1' });
	const approved = { ...mine, reviews: { status: 'approved' as const, reviewers: [{ login: 'bob', avatarUrl: '', state: 'APPROVED' }] } };

	const [approval] = notificationsFor(data({ myPRs: [mine] }), data({ myPRs: [approved] }), 'me');
	assert.equal(approval.kind, 'approved');
	assert.match(approval.message, /@bob approved/);

	const changes = {
		...mine,
		reviews: {
			status: 'changes_requested' as const,
			reviewers: [{ login: 'bob', avatarUrl: '', state: 'CHANGES_REQUESTED' }],
			openThreadCount: 3,
			firstUnresolvedThreadUrl: 'https://github.com/acme/api/pull/1#discussion_r1',
		},
	};

	const [rejection] = notificationsFor(data({ myPRs: [mine] }), data({ myPRs: [changes] }), 'me');
	assert.equal(rejection.kind, 'changes_requested');
	assert.match(rejection.message, /3 open threads/);
	assert.equal(rejection.url, changes.reviews.firstUnresolvedThreadUrl, 'clicking should land on the thread, not the PR top');

	// Going back to pending is a re-request or a dismissal. Nobody needs to be told.
	assert.deepEqual(notificationsFor(data({ myPRs: [changes] }), data({ myPRs: [mine] }), 'me'), []);
}

function testChecksOnlyFailAndRecover(): void {
	const unknown = pr({ id: '1' });
	const green = { ...unknown, checks: { status: 'success' as const } };
	const red = { ...unknown, checks: { status: 'failure' as const } };
	const pending = { ...unknown, checks: { status: 'pending' as const } };

	// A rollup appearing for the first time is CI being configured, not a result.
	assert.deepEqual(notificationsFor(data({ myPRs: [unknown] }), data({ myPRs: [green] }), 'me'), []);
	// Ordinary churn while a build runs.
	assert.deepEqual(notificationsFor(data({ myPRs: [green] }), data({ myPRs: [pending] }), 'me'), []);

	assert.equal(notificationsFor(data({ myPRs: [green] }), data({ myPRs: [red] }), 'me')[0].kind, 'ci_failed');
	assert.equal(notificationsFor(data({ myPRs: [red] }), data({ myPRs: [green] }), 'me')[0].kind, 'ci_recovered');
}

function testConflicts(): void {
	const at = (mergeable?: PullRequest['mergeable']) => pr({ id: '1', mergeable });
	const fire = (from?: PullRequest['mergeable'], to?: PullRequest['mergeable']) =>
		notificationsFor(data({ myPRs: [at(from)] }), data({ myPRs: [at(to)] }), 'me').map((spec) => spec.kind);

	assert.deepEqual(fire('mergeable', 'conflicting'), ['conflicts']);
	// The usual path: a base push resets GitHub's lazy check, and the next poll sees the conflict.
	assert.deepEqual(fire('unknown', 'conflicting'), ['conflicts']);
	assert.deepEqual(fire('conflicting', 'conflicting'), []);
	// Resolving them is your own doing; nothing to tell you.
	assert.deepEqual(fire('conflicting', 'mergeable'), []);
	// No baseline (cache from before this field existed): not a change.
	assert.deepEqual(fire(undefined, 'conflicting'), []);

	// Someone else's PR conflicting is theirs to fix.
	assert.deepEqual(
		notificationsFor(
			data({ reviewRequests: [requested('1', { mergeable: 'mergeable' })] }),
			data({ reviewRequests: [requested('1', { mergeable: 'conflicting' })] }),
			'me',
		),
		[],
	);
}

function testDisappearingPRs(): void {
	const mine = pr({ id: '1' });
	const [closed] = notificationsFor(data({ myPRs: [mine] }), data(), 'me');
	assert.equal(closed.kind, 'closed');
	assert.equal(closed.url, mine.url);

	// A withdrawn review request is not a closed PR, and is not worth saying anything about.
	assert.deepEqual(notificationsFor(data({ reviewRequests: [requested('1')] }), data(), 'me'), []);
}

function testMergedVersusClosed(): void {
	const previous = data({ myPRs: [pr({ id: '1' })] });
	const gone = (state?: string) => notificationsFor(previous, data(), 'me', new Map(state ? [['1', state]] : []));

	// Lookup failed: the honest fallback, not a guess.
	assert.equal(gone()[0].message, 'No longer open — merged or closed · title');

	assert.equal(gone('merged')[0].kind, 'merged');
	assert.equal(gone('merged')[0].message, 'Merged · title');
	assert.equal(gone('closed')[0].kind, 'closed');
	assert.equal(gone('closed')[0].message, 'Closed without merging · title');

	// Still open, just fell off the capped search. Saying "closed" here would be a lie.
	assert.deepEqual(gone('open'), []);

	// Grouped, merged and closed stay separate so each headline is decisive.
	const two = data({ myPRs: [pr({ id: '1' }), pr({ id: '2', number: 2 }), pr({ id: '3', number: 3 })] });
	const specs = notificationsFor(
		two,
		data(),
		'me',
		new Map([
			['1', 'merged'],
			['2', 'merged'],
			['3', 'closed'],
		]),
		true,
	);
	assert.deepEqual(
		specs.map((spec) => spec.title),
		['2 of your PRs were merged', 'acme/api #3'],
	);
}

function testIdCarriesTheClickTarget(): void {
	const mine = pr({ id: '1' });
	const red = { ...mine, checks: { status: 'failure' as const } };
	const green = { ...mine, checks: { status: 'success' as const } };

	// MV3 can tear the worker down between firing and the click, so the URL rides in the id.
	const [spec] = notificationsFor(data({ myPRs: [green] }), data({ myPRs: [red] }), 'me');
	assert.equal(spec.id, `ci_failed|${mine.url}`);
	assert.equal(spec.id.slice(spec.id.indexOf('|') + 1), spec.url);
}

function testStaleCache(): void {
	const MIN = 60_000;
	assert.equal(isStaleCache(null, LAST_FETCH, 10 * MIN), false);
	// Within three missed polls, or 30 minutes, the diff is still meaningful.
	assert.equal(isStaleCache(LAST_FETCH, LAST_FETCH + 30 * MIN, 10 * MIN), false);
	assert.equal(isStaleCache(LAST_FETCH, LAST_FETCH + 31 * MIN, 10 * MIN), true);
	assert.equal(isStaleCache(LAST_FETCH, LAST_FETCH + 60 * MIN, 30 * MIN), false);
	assert.equal(isStaleCache(LAST_FETCH, LAST_FETCH + 91 * MIN, 30 * MIN), true);
}

testStaleCache();
testFirstRunIsSilent();
testDiffSizeRidesAlong();
testReviewRequestNeedsAnOutstandingAsk();
testReviewRequestWording();
testSeparateByDefault();
testGroupingCollapsesOneKind();
testReviewVerdictsOnMyPRs();
testChecksOnlyFailAndRecover();
testConflicts();
testDisappearingPRs();
testMergedVersusClosed();
testIdCarriesTheClickTarget();
console.log('pr-notify: all checks passed');
