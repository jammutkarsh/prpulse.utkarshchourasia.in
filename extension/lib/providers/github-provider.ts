import { AUTH_ERROR_CODE, ProviderError } from '../errors';
import type {
	PrSource,
	PrSourceResult,
	PullRequest,
	PullRequestChecks,
	PullRequestRepoOwner,
	PullRequestReviewer,
	PullRequestReviews,
	ProviderConfig,
	User,
} from '../types';

type GraphQLReview = {
	databaseId: number | null;
	state: string;
	author: { login: string; avatarUrl: string } | null;
};

type GraphQLPullRequest = {
	id: string;
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	mergeable: string;
	createdAt: string;
	updatedAt: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	headRefName: string;
	author: { login: string; avatarUrl: string; name?: string | null } | null;
	repository: { nameWithOwner: string; owner: { login: string; __typename: string } } | null;
	commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
	reviews: { nodes: GraphQLReview[] };
	reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string } | null }> };
	reviewThreads: {
		nodes: Array<{ isResolved: boolean; isOutdated: boolean; comments: { nodes: Array<{ url: string; createdAt: string }> } }>;
	};
};

type RateLimit = { cost: number; remaining: number };

type CountResponse = {
	rateLimit: RateLimit | null;
	myPRs: { issueCount: number } | null;
	reviewRequests: { issueCount: number } | null;
	reviewedPRs: { issueCount: number } | null;
};

type SearchResponse = {
	rateLimit: RateLimit | null;
	search: {
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
		nodes: Array<GraphQLPullRequest | null>;
	} | null;
};

type StatesResponse = {
	rateLimit: RateLimit | null;
	nodes: Array<{ id?: string; state?: string } | null>;
};

// GraphQL point cost is charged on the nodes a query *requests*, not the ones it returns, and nested
// connections multiply by their parent's page size. So each PR node here costs roughly
// 1 + REVIEWS + REVIEW_REQUESTS + REVIEW_THREADS nodes, and the search page size multiplies all of it.
const MAX_PAGE_SIZE = 100;
// The cap is on PRs, not pages: a view that had to shrink its page size after a timeout still gets
// the same coverage as one that fetched full pages.
const MAX_PRS_PER_VIEW = 300;
// GitHub abandons a GraphQL query that runs past its ~10s budget and answers 502 or 504. Wall time
// grows with the page size, so a full page of PRs with all their nested reviews can time out on
// every attempt for an account with many open PRs. Halve and retry the same cursor, down to this floor.
const MIN_PAGE_SIZE = 10;
const REVIEWS_PAGE_SIZE = 50;
const REVIEW_REQUESTS_PAGE_SIZE = 20;
const REVIEW_THREADS_PAGE_SIZE = 25;

const SEARCH_QUERIES = {
	myPRs: 'author:@me type:pr state:open sort:updated-desc',
	reviewRequests: 'review-requested:@me type:pr state:open sort:updated-desc',
	reviewedPRs: 'reviewed-by:@me -author:@me type:pr state:open sort:updated-desc',
};

type SearchView = keyof typeof SEARCH_QUERIES;

// issueCount is a scalar on the connection, so this whole probe costs 3 nodes — one point. Sizing the
// real queries to the answer beats a fixed first: 100, which bills a 7-PR user the same as a 100-PR one.
const COUNT_QUERY = `query($myPRs: String!, $reviewRequests: String!, $reviewedPRs: String!) {
	rateLimit { cost remaining }
	myPRs: search(query: $myPRs, type: ISSUE, first: 1) { issueCount }
	reviewRequests: search(query: $reviewRequests, type: ISSUE, first: 1) { issueCount }
	reviewedPRs: search(query: $reviewedPRs, type: ISSUE, first: 1) { issueCount }
}`;

// A PR that dropped out of `state:open` search was merged, closed — or is still open and merely fell
// past the page cap. `search` can't say which, so the vanished ids are looked up directly.
const STATES_QUERY = `query($ids: [ID!]!) {
	rateLimit { cost remaining }
	nodes(ids: $ids) { ... on PullRequest { id state } }
}`;

const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
	rateLimit { cost remaining }
	search(query: $q, type: ISSUE, first: $first, after: $after) {
		pageInfo { hasNextPage endCursor }
		nodes {
			... on PullRequest {
				id
				number
				title
				url
				state
				isDraft
				mergeable
				createdAt
				updatedAt
				additions
				deletions
				changedFiles
				headRefName
				author { login avatarUrl ... on User { name } }
				repository { nameWithOwner owner { login __typename } }
				commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
				reviews(last: ${REVIEWS_PAGE_SIZE}) { nodes { databaseId state author { login avatarUrl } } }
				reviewRequests(first: ${REVIEW_REQUESTS_PAGE_SIZE}) { nodes { requestedReviewer { ... on User { login } } } }
				reviewThreads(first: ${REVIEW_THREADS_PAGE_SIZE}) { nodes { isResolved isOutdated comments(first: 1) { nodes { url createdAt } } } }
			}
		}
	}
}`;

// GraphQL enums are uppercase and closed sets. Map them explicitly so an enum GitHub adds later shows up
// as a warning rather than silently lowercasing into a value nothing downstream handles.
const CHECK_STATUS_BY_ROLLUP: Record<string, PullRequestChecks['status']> = {
	SUCCESS: 'success',
	FAILURE: 'failure',
	ERROR: 'failure',
	PENDING: 'pending',
	EXPECTED: 'pending',
};

const PULL_REQUEST_STATE: Record<string, string> = {
	OPEN: 'open',
	CLOSED: 'closed',
	MERGED: 'merged',
};

const MERGEABLE_STATE: Record<string, NonNullable<PullRequest['mergeable']>> = {
	MERGEABLE: 'mergeable',
	CONFLICTING: 'conflicting',
	UNKNOWN: 'unknown',
};

const OWNER_TYPE: Record<string, PullRequestRepoOwner['type']> = {
	Organization: 'org',
	User: 'user',
};

const REVIEW_STATE = {
	approved: 'APPROVED',
	changesRequested: 'CHANGES_REQUESTED',
	dismissed: 'DISMISSED',
	commented: 'COMMENTED',
	pending: 'PENDING',
} as const;

const KNOWN_REVIEW_STATES: ReadonlySet<string> = new Set(Object.values(REVIEW_STATE));

function mapEnum<T>(map: Record<string, T>, value: string | null | undefined, fallback: T, label: string): T {
	if (value && value in map) {
		return map[value];
	}

	if (value) {
		console.warn(`GitHub GraphQL: unrecognized ${label} "${value}", falling back to "${fallback}"`);
	}

	return fallback;
}

/**
 * Page size for the next request: whatever the count probe says is left, clamped to GitHub's max.
 * Floors at 1 because GraphQL rejects `first: 0`, and the loop only gets here when more is expected.
 */
// The count and the click-through target must agree: both read the same isResolved/isOutdated filter,
// so a link never points at a thread the badge doesn't count as open. GitHub's reviewThreads connection
// order isn't documented as chronological, so "first" is decided here by comment createdAt rather than
// trusting array position — ISO 8601 strings sort correctly with plain string comparison.
export function firstUnresolvedThreadUrl(
	threads: Array<{ isResolved: boolean; isOutdated: boolean; comments: { nodes: Array<{ url: string; createdAt: string }> } }>,
): string | undefined {
	const open = threads.filter((thread) => !thread.isResolved && !thread.isOutdated && thread.comments.nodes[0]);
	open.sort((a, b) => (a.comments.nodes[0].createdAt < b.comments.nodes[0].createdAt ? -1 : 1));
	return open[0]?.comments.nodes[0]?.url;
}

export function nextPageSize(issueCount: number, alreadySeen: number): number {
	return Math.min(Math.max(issueCount - alreadySeen, 1), MAX_PAGE_SIZE);
}

/** A 502/504 from GitHub's GraphQL endpoint is its query timeout, not an outage: a smaller page can succeed. */
export function isQueryTimeout(error: unknown): boolean {
	const statusCode = error instanceof ProviderError ? error.details.statusCode : undefined;
	return statusCode === 502 || statusCode === 504;
}

/** The page size to retry a timed-out page with, or null once there is nothing smaller worth trying. */
export function smallerPageSize(first: number): number | null {
	if (first <= MIN_PAGE_SIZE) {
		return null;
	}

	return Math.max(Math.floor(first / 2), MIN_PAGE_SIZE);
}

export class GitHubProvider implements PrSource {
	baseUrl: string;
	token: string;

	constructor(config: ProviderConfig = {}) {
		this.token = config.token || '';
		this.baseUrl = config.baseUrl || 'https://api.github.com';
	}

	async #request(url: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(url, {
			...init,
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${this.token}`,
				...init.headers,
			},
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}) as { message?: string });
			const statusCode = response.status;
			// Tagged here so no caller has to recognise a dead token by its status code or message text.
			throw new ProviderError(
				error.message || `GitHub API error: ${statusCode}`,
				statusCode === 401 ? AUTH_ERROR_CODE : 'API_ERROR',
				{
					statusCode,
					retryable: statusCode === 429 || statusCode >= 500,
					provider: 'github',
				},
			);
		}

		return response;
	}

	// GitHub occasionally returns 2xx with an empty body (rate-limit edge cases, proxies). A bare
	// response.json() throws "Unexpected end of JSON input" there, which surfaces as an opaque
	// fetch failure instead of a diagnosable provider error.
	async #json<T>(response: Response): Promise<T> {
		const text = await response.text();
		if (!text) {
			throw new ProviderError('GitHub returned an empty response', 'API_ERROR', {
				statusCode: response.status,
				retryable: true,
				provider: 'github',
			});
		}
		return JSON.parse(text) as T;
	}

	async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		// GHES exposes GraphQL at /api/graphql while REST lives at /api/v3
		const url = this.baseUrl.endsWith('/api/v3') ? `${this.baseUrl.slice(0, -3)}/graphql` : `${this.baseUrl}/graphql`;
		const response = await this.#request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables }),
		});

		const body = await this.#json<{ data?: T; errors?: Array<{ message: string }> }>(response);

		// A single unreadable repo returns null for that node plus an error entry. Keep the rest
		// of the refresh alive instead of failing every PR because of one.
		if (body.errors?.length) {
			if (!body.data) {
				throw new ProviderError(body.errors[0].message, 'API_ERROR', { provider: 'github' });
			}
			console.warn(
				'GitHub GraphQL returned partial data:',
				body.errors.map((e) => e.message),
			);
		}

		if (!body.data) {
			throw new ProviderError('GitHub GraphQL response missing data', 'PARSE_ERROR', { provider: 'github' });
		}

		return body.data;
	}

	#logCost(label: string, rateLimit: RateLimit | null): void {
		if (rateLimit) {
			console.debug(`GitHub GraphQL ${label}: cost=${rateLimit.cost}, remaining=${rateLimit.remaining}`);
		}
	}

	// Stays on REST: the token expiry date is only exposed as a response header, and GraphQL has no
	// equivalent field. Not on the refresh path, so it costs nothing per poll.
	async getUser(): Promise<User> {
		const response = await this.#request(`${this.baseUrl}/user`, {
			headers: { Accept: 'application/vnd.github.v3+json' },
		});

		const data = await this.#json<{ login: string; avatar_url: string; name?: string }>(response);

		return {
			login: data.login,
			avatarUrl: data.avatar_url,
			name: data.name || data.login,
			tokenExpiration: response.headers.get('github-authentication-token-expiration') || null,
		};
	}

	#buildChecks(pr: GraphQLPullRequest): PullRequestChecks {
		// GitHub's own rollup verdict. Reading it instead of folding over a contexts connection means a PR
		// with more checks than the page size can't report green by hiding the failing one past the cap.
		const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
		if (!state) {
			return { status: 'unknown' };
		}

		return { status: mapEnum(CHECK_STATUS_BY_ROLLUP, state, 'unknown', 'statusCheckRollup state') };
	}

	#buildReviews(pr: GraphQLPullRequest): PullRequestReviews {
		const pendingReviewers = (pr.reviewRequests?.nodes || [])
			.map((node) => node.requestedReviewer?.login)
			.filter((login): login is string => !!login);
		const reRequested = new Set(pendingReviewers);
		const reviews = pr.reviews?.nodes || [];
		const reviewerMap = new Map<string, PullRequestReviewer>();

		for (const review of reviews) {
			if (!review.author) {
				continue;
			}

			if (!KNOWN_REVIEW_STATES.has(review.state)) {
				console.warn(`GitHub GraphQL: unrecognized review state "${review.state}", ignoring review`);
				continue;
			}

			// PENDING and COMMENTED carry no verdict, and a re-requested reviewer's old verdict is stale.
			if (review.state === REVIEW_STATE.pending || review.state === REVIEW_STATE.commented) {
				continue;
			}

			if (reRequested.has(review.author.login)) {
				continue;
			}

			reviewerMap.set(review.author.login, {
				login: review.author.login,
				avatarUrl: review.author.avatarUrl,
				state: review.state,
			});
		}

		const reviewers = Array.from(reviewerMap.values());

		let status: PullRequestReviews['status'];
		if (reviewers.some((reviewer) => reviewer.state === REVIEW_STATE.changesRequested)) {
			status = 'changes_requested';
		} else if (pendingReviewers.length > 0 || reviewers.length === 0) {
			status = 'pending';
		} else {
			status = reviewers.every((reviewer) => reviewer.state === REVIEW_STATE.approved) ? 'approved' : 'pending';
		}

		let changesRequestedReviewId: number | undefined;
		let openThreadCount: number | undefined;
		let unresolvedThreadUrl: string | undefined;
		if (status === 'changes_requested') {
			// Reviews come back oldest-first; the last one is the most recent, for deep-linking.
			const changesRequested = reviews.filter((review) => review.state === REVIEW_STATE.changesRequested);
			changesRequestedReviewId = changesRequested[changesRequested.length - 1]?.databaseId ?? undefined;

			// Only GraphQL exposes thread resolution state; REST review comments have no
			// isResolved/isOutdated, which is why resolved threads used to be counted as open.
			// Caps at REVIEW_THREADS_PAGE_SIZE — a busier PR under-reports rather than costing every PR more.
			const threads = pr.reviewThreads?.nodes || [];
			openThreadCount = threads.filter((thread) => !thread.isResolved && !thread.isOutdated).length;
			unresolvedThreadUrl = firstUnresolvedThreadUrl(threads);
		}

		return {
			status,
			reviewers,
			pendingReviewers,
			openThreadCount,
			changesRequestedReviewId,
			firstUnresolvedThreadUrl: unresolvedThreadUrl,
		};
	}

	#transformPullRequest(pr: GraphQLPullRequest): PullRequest {
		const repoFullName = pr.repository?.nameWithOwner || '';
		const authorLogin = pr.author?.login || '';

		return {
			id: `github-${pr.id}`,
			provider: 'github',
			number: pr.number,
			title: pr.title,
			url: pr.url,
			repoFullName,
			repoOwner: {
				login: pr.repository?.owner?.login || repoFullName.split('/')[0] || '',
				type: mapEnum(OWNER_TYPE, pr.repository?.owner?.__typename, 'unknown', 'repository owner type'),
			},
			branchName: pr.headRefName || '',
			author: {
				login: authorLogin,
				avatarUrl: pr.author?.avatarUrl || '',
				name: pr.author?.name || authorLogin,
			},
			state: mapEnum(PULL_REQUEST_STATE, pr.state, 'open', 'pull request state'),
			changes: {
				additions: pr.additions,
				deletions: pr.deletions,
				filesChanged: pr.changedFiles,
			},
			checks: this.#buildChecks(pr),
			reviews: this.#buildReviews(pr),
			createdAt: pr.createdAt,
			updatedAt: pr.updatedAt,
			isDraft: pr.isDraft,
			mergeable: mapEnum(MERGEABLE_STATE, pr.mergeable, 'unknown', 'mergeable state'),
		};
	}

	async #fetchView(view: SearchView, issueCount: number): Promise<PullRequest[]> {
		const pullRequests: PullRequest[] = [];
		let cursor: string | null = null;
		let dropped = 0;
		// Lowered after a timeout and kept low: the next page of the same view would time out just the same.
		let pageSizeLimit = MAX_PAGE_SIZE;

		for (let page = 1; ; page++) {
			const seen = pullRequests.length + dropped;
			if (seen >= MAX_PRS_PER_VIEW) {
				console.warn(`GitHub GraphQL ${view}: stopped at the ${MAX_PRS_PER_VIEW}-PR cap; more are available`);
				break;
			}

			const first = Math.min(nextPageSize(issueCount, seen), pageSizeLimit, MAX_PRS_PER_VIEW - seen);
			let data: SearchResponse;
			try {
				data = await this.#graphql<SearchResponse>(SEARCH_QUERY, { q: SEARCH_QUERIES[view], first, after: cursor });
			} catch (error) {
				const smaller = isQueryTimeout(error) ? smallerPageSize(first) : null;
				if (smaller === null) {
					throw error;
				}

				console.warn(`GitHub GraphQL ${view} page ${page} timed out at first: ${first}; retrying with first: ${smaller}`);
				pageSizeLimit = smaller;
				page--;
				continue;
			}
			this.#logCost(`${view} page ${page} (first: ${first})`, data.rateLimit);

			const nodes = data.search?.nodes || [];
			for (const node of nodes) {
				if (!node?.id) {
					dropped++;
					continue;
				}

				pullRequests.push(this.#transformPullRequest(node));
			}

			// issueCount is a snapshot from the probe, so hasNextPage — not the count — ends the loop.
			// A PR opened between the probe and this request still gets picked up.
			// The PR cap only bounds the loop while pages make progress; an empty page that still claims a
			// next one would otherwise loop forever.
			if (!data.search?.pageInfo?.hasNextPage || nodes.length === 0) {
				break;
			}

			cursor = data.search.pageInfo.endCursor;
		}

		if (dropped > 0) {
			// Null nodes are PRs in repos the token can't read — SSO-restricted, archived, or since deleted.
			// They are dropped from the view, so say so rather than letting them vanish silently.
			console.warn(`GitHub GraphQL ${view}: dropped ${dropped} unreadable PR node(s); they will not appear in the dashboard`);
		}

		return pullRequests;
	}

	async getAllPullRequests(): Promise<PrSourceResult> {
		const counts = await this.#graphql<CountResponse>(COUNT_QUERY, SEARCH_QUERIES);
		this.#logCost('count probe', counts.rateLimit);

		const [myPRs, reviewRequests, reviewedPRs] = await Promise.all(
			(['myPRs', 'reviewRequests', 'reviewedPRs'] as const).map((view) => {
				const issueCount = counts[view]?.issueCount ?? 0;
				// Nothing to fetch: skip the request entirely rather than paying for an empty page.
				return issueCount === 0 ? Promise.resolve([]) : this.#fetchView(view, issueCount);
			}),
		);

		// Already-reviewed PRs belong in the same list as pending review requests, minus the overlap.
		const seen = new Set(reviewRequests.map((pr) => pr.id));
		const merged = [...reviewRequests];
		for (const pr of reviewedPRs) {
			if (!seen.has(pr.id)) {
				seen.add(pr.id);
				merged.push(pr);
			}
		}

		return { myPRs, reviewRequests: merged };
	}

	async getStates(ids: string[]): Promise<Map<string, string>> {
		// Transformed ids carry a `github-` prefix for cross-provider uniqueness; `nodes(ids:)` wants it off.
		const data = await this.#graphql<StatesResponse>(STATES_QUERY, { ids: ids.map((id) => id.replace(/^github-/, '')) });
		this.#logCost('states', data.rateLimit);

		const states = new Map<string, string>();
		for (const node of data.nodes || []) {
			if (node?.id) {
				states.set(`github-${node.id}`, mapEnum(PULL_REQUEST_STATE, node.state, 'open', 'pull request state'));
			}
		}

		return states;
	}
}
