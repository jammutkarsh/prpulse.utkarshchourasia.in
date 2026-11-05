import assert from 'node:assert/strict';
import { ProviderError } from '../errors';
import { firstUnresolvedThreadUrl, GitHubProvider, isQueryTimeout, nextPageSize, smallerPageSize } from './github-provider';

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

// GitHub's GraphQL timeout surfaces as 502/504. Only those may shrink the page; anything else is a
// real failure and must still throw. Run with: bun run test
function testTimeoutShrinking(): void {
	const error = (statusCode: number) => new ProviderError('GitHub API error', 'API_ERROR', { statusCode });

	assert.equal(isQueryTimeout(error(502)), true);
	assert.equal(isQueryTimeout(error(504)), true);
	assert.equal(isQueryTimeout(error(500)), false);
	assert.equal(isQueryTimeout(error(401)), false);
	assert.equal(isQueryTimeout(new TypeError('Failed to fetch')), false);

	// Halves, floors at the minimum, then gives up.
	assert.equal(smallerPageSize(100), 50);
	assert.equal(smallerPageSize(50), 25);
	assert.equal(smallerPageSize(25), 12);
	assert.equal(smallerPageSize(12), 10);
	assert.equal(smallerPageSize(10), null);
	assert.equal(smallerPageSize(7), null);
}

testTimeoutShrinking();

/**
 * A fake GraphQL endpoint holding `total` open PRs that times out (502) on any search page larger
 * than `maxFirst`, which is how GitHub behaves for an account with many open PRs.
 */
function fakeGitHub(total: number, maxFirst: number, status = 502) {
	const searchSizes: number[] = [];

	const fetchStub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const { query, variables } = JSON.parse(String(init?.body));
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

		if (query.includes('issueCount')) {
			return json({
				data: { rateLimit: null, myPRs: { issueCount: total }, reviewRequests: { issueCount: 0 }, reviewedPRs: { issueCount: 0 } },
			});
		}

		searchSizes.push(variables.first);
		if (variables.first > maxFirst) {
			return new Response('', { status });
		}

		const start = variables.after ? Number(variables.after) : 0;
		const end = Math.min(start + variables.first, total);
		const nodes = Array.from({ length: end - start }, (_, i) => ({
			id: `PR_${start + i}`,
			number: start + i,
			title: 't',
			url: 'https://github.com/o/r/pull/1',
		}));
		return json({ data: { rateLimit: null, search: { pageInfo: { hasNextPage: end < total, endCursor: String(end) }, nodes } } });
	};

	return { fetchStub, searchSizes };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	const originalWarn = console.warn;
	globalThis.fetch = stub;
	console.warn = () => {};
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
		console.warn = originalWarn;
	}
}

async function testFetchSurvivesQueryTimeouts(): Promise<void> {
	// 155 open PRs, and the default 25-PR page never times out: no retries at all.
	const healthy = fakeGitHub(155, 25);
	const fetched = await withFetch(healthy.fetchStub as typeof fetch, () => new GitHubProvider({ token: 't' }).getAllPullRequests());
	assert.equal(fetched.myPRs.length, 155);
	assert.deepEqual(healthy.searchSizes, [25, 25, 25, 25, 25, 25, 5]);

	// Anything above 12 per page times out. All 155 must still load, and once shrunk the view stays
	// shrunk rather than timing out again on every page.
	const busy = fakeGitHub(155, 12);
	const result = await withFetch(busy.fetchStub as typeof fetch, () => new GitHubProvider({ token: 't' }).getAllPullRequests());
	assert.equal(result.myPRs.length, 155);
	assert.equal(new Set(result.myPRs.map((pr) => pr.id)).size, 155);
	assert.deepEqual(busy.searchSizes, [25, ...Array(12).fill(12), 11]);

	// 504 is treated the same way.
	const gateway = fakeGitHub(30, 12, 504);
	const viaGateway = await withFetch(gateway.fetchStub as typeof fetch, () => new GitHubProvider({ token: 't' }).getAllPullRequests());
	assert.equal(viaGateway.myPRs.length, 30);
	assert.deepEqual(gateway.searchSizes, [25, 12, 12, 6]);

	// Still timing out at the floor: give up and surface the error rather than retrying forever.
	const hopeless = fakeGitHub(155, 5);
	await assert.rejects(
		withFetch(hopeless.fetchStub as typeof fetch, () => new GitHubProvider({ token: 't' }).getAllPullRequests()),
		(error: unknown) => isQueryTimeout(error),
	);
	assert.deepEqual(hopeless.searchSizes, [25, 12, 10]);

	// The 300-PR cap still applies when pages are small.
	const huge = fakeGitHub(1000, 25);
	const capped = await withFetch(huge.fetchStub as typeof fetch, () => new GitHubProvider({ token: 't' }).getAllPullRequests());
	assert.equal(capped.myPRs.length, 300);
}

await testFetchSurvivesQueryTimeouts();
console.log('github-provider: all checks passed');
