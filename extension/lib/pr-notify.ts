import type { PrSourceResult, PullRequest, PullRequestData } from './types';

// What changed since the last poll, and what to say about it. Kept pure and polyfill-free for the
// same reason `pr-view.ts` is: the rules are the interesting part, and none of them need a browser.
// The service worker only wires this to `notifications.create`.
//
// Filters are deliberately not consulted. A filter is a preference about what the dashboard shows,
// not a statement about what is worth interrupting you for.

export type NotifyKind =
	'review_requested' | 'approved' | 'changes_requested' | 'ci_failed' | 'ci_recovered' | 'conflicts' | 'merged' | 'closed';

/** Where a grouped notification points. The worker swaps it for a `runtime.getURL`, which this module cannot call. */
export const DASHBOARD_URL = 'popup/popup.html?fullpage=1';

export interface NotifySpec {
	kind: NotifyKind;
	/**
	 * `${kind}|${url}`. The click target rides inside the id because MV3 can tear the worker down
	 * between firing a notification and the user clicking it — an in-memory map would not survive.
	 * Re-notifying about the same PR reuses the id, so the OS replaces rather than stacks.
	 */
	id: string;
	title: string;
	message: string;
	/** Label for button 0. Button 1 is always Dismiss, added by the caller. */
	action: string;
	/** The dimmed third line: how big the PR is. Absent on grouped notifications, which span several. */
	detail?: string;
	url: string;
}

interface Event {
	kind: NotifyKind;
	pr: PullRequest;
	title: string;
	message: string;
	action: string;
	url: string;
}

/** How big the change is, in the shape a diff is usually read: `+30 −40 · 3 files`. */
function sizeOf(pr: PullRequest): string {
	const { additions, deletions, filesChanged } = pr.changes;
	const files = filesChanged ? ` · ${filesChanged} file${filesChanged === 1 ? '' : 's'}` : '';

	return `+${additions} −${deletions}${files}`;
}

function byId(items: PullRequest[] | undefined): Map<string, PullRequest> {
	return new Map((items || []).map((pr) => [pr.id, pr]));
}

function label(pr: PullRequest): string {
	return `${pr.repoFullName} #${pr.number}`;
}

/** Whoever's verdict this is. The reviewer list is already deduped to one entry per login. */
function reviewerWith(pr: PullRequest, state: string): string {
	const reviewer = pr.reviews.reviewers?.find((entry) => entry.state === state);
	return reviewer ? `@${reviewer.login}` : 'A reviewer';
}

function reviewRequestEvent(pr: PullRequest, since: number): Event {
	// A PR that did not exist at the last poll is a new ask on new work; an older one means someone
	// added you to something already in flight. Same notification, different sentence.
	const isNew = Date.parse(pr.createdAt) > since;
	const verb = isNew ? 'opened a PR for your review' : 'requested your review';

	return {
		kind: 'review_requested',
		pr,
		title: label(pr),
		message: `@${pr.author.login} ${verb} · ${pr.title}`,
		action: 'Review',
		url: pr.url,
	};
}

function reviewStatusEvent(previous: PullRequest, next: PullRequest): Event | null {
	if (previous.reviews.status === next.reviews.status) {
		return null;
	}

	if (next.reviews.status === 'approved') {
		return {
			kind: 'approved',
			pr: next,
			title: label(next),
			message: `${reviewerWith(next, 'APPROVED')} approved your pull request`,
			action: 'Open',
			url: next.url,
		};
	}

	if (next.reviews.status === 'changes_requested') {
		const open = next.reviews.openThreadCount;
		const threads = open ? ` · ${open} open thread${open === 1 ? '' : 's'}` : '';

		return {
			kind: 'changes_requested',
			pr: next,
			title: label(next),
			message: `${reviewerWith(next, 'CHANGES_REQUESTED')} requested changes${threads}`,
			action: 'Open',
			// The deep link to the first thread still needing an answer, when the provider found one.
			url: next.reviews.firstUnresolvedThreadUrl || next.url,
		};
	}

	// Falling back to `pending` — a re-request, or a dismissed review. Nothing to interrupt anyone for.
	return null;
}

function checksEvent(previous: PullRequest, next: PullRequest): Event | null {
	const from = previous.checks.status;
	const to = next.checks.status;

	// `unknown` means "no rollup", not "no failures". Treating it as a state would fire on every PR
	// the moment CI is first configured, and again whenever the rollup is briefly missing.
	if (from === to || from === 'unknown' || to === 'unknown') {
		return null;
	}

	if (to === 'failure') {
		return {
			kind: 'ci_failed',
			pr: next,
			title: label(next),
			message: `Checks failed · ${next.title}`,
			action: 'Open',
			url: next.url,
		};
	}

	if (from === 'failure' && to === 'success') {
		return {
			kind: 'ci_recovered',
			pr: next,
			title: label(next),
			message: 'Checks are passing again',
			action: 'Open',
			url: next.url,
		};
	}

	return null;
}

function conflictsEvent(previous: PullRequest, next: PullRequest): Event | null {
	// Absent means an older cache or a source that can't tell — no baseline, so no claim of a change.
	// `unknown` in between is fine to fire across: a base-branch push both causes the conflict and
	// resets GitHub's lazy check, so mergeable -> unknown -> conflicting is the usual path.
	// ponytail: conflicting -> unknown -> conflicting re-fires; same id, so the OS replaces, not stacks.
	if (next.mergeable !== 'conflicting' || !previous.mergeable || previous.mergeable === 'conflicting') {
		return null;
	}

	return {
		kind: 'conflicts',
		pr: next,
		title: label(next),
		message: `Has merge conflicts · ${next.title}`,
		action: 'Open',
		url: next.url,
	};
}

/** `state` is the PR's state after it left the open list; undefined when the lookup failed. */
function goneEvent(pr: PullRequest, state: string | undefined): Event | null {
	// Still open: it only fell past the search page cap, or its repo turned unreadable. Not news.
	if (state === 'open') {
		return null;
	}

	const message = state === 'merged' ? 'Merged' : state === 'closed' ? 'Closed without merging' : 'No longer open — merged or closed';

	return {
		kind: state === 'merged' ? 'merged' : 'closed',
		pr,
		title: label(pr),
		message: `${message} · ${pr.title}`,
		action: 'Open',
		url: pr.url,
	};
}

function collectEvents(previous: PullRequestData, next: PrSourceResult, me: string, since: number, states: Map<string, string>): Event[] {
	const events: Event[] = [];

	const previousReviewRequests = byId(previous.reviewRequests);
	for (const pr of next.reviewRequests || []) {
		// `reviewRequests` also carries PRs you have already reviewed (the provider merges
		// `reviewed-by:@me` into this list). Only an outstanding request is news.
		if (previousReviewRequests.has(pr.id) || !pr.reviews.pendingReviewers?.includes(me)) {
			continue;
		}

		events.push(reviewRequestEvent(pr, since));
	}

	const nextMine = byId(next.myPRs);
	for (const [id, previousPr] of byId(previous.myPRs)) {
		const nextPr = nextMine.get(id);

		if (!nextPr) {
			// Only your own PRs. A PR leaving `reviewRequests` usually just means the request was
			// withdrawn, which is not worth a notification.
			const gone = goneEvent(previousPr, states.get(id));
			if (gone) events.push(gone);
			continue;
		}

		const review = reviewStatusEvent(previousPr, nextPr);
		if (review) events.push(review);

		const checks = checksEvent(previousPr, nextPr);
		if (checks) events.push(checks);

		const conflicts = conflictsEvent(previousPr, nextPr);
		if (conflicts) events.push(conflicts);
	}

	return events;
}

function unique<T>(values: T[]): T[] {
	return Array.from(new Set(values));
}

const GROUP_HEADLINE: Record<NotifyKind, (count: number) => string> = {
	review_requested: (count) => `${count} PRs need your review`,
	approved: (count) => `${count} of your PRs were approved`,
	changes_requested: (count) => `${count} of your PRs need changes`,
	ci_failed: (count) => `Checks failed on ${count} of your PRs`,
	ci_recovered: (count) => `Checks are passing again on ${count} of your PRs`,
	conflicts: (count) => `${count} of your PRs have merge conflicts`,
	merged: (count) => `${count} of your PRs were merged`,
	closed: (count) => `${count} of your PRs were closed`,
};

/** What the batch has in common, if anything — the one detail worth keeping when the titles are gone. */
function groupDetail(events: Event[]): string {
	const repos = unique(events.map((event) => event.pr.repoFullName));
	if (repos.length === 1) {
		return `in ${repos[0]}`;
	}

	const authors = unique(events.map((event) => event.pr.author.login));
	if (authors.length === 1) {
		return `from @${authors[0]}`;
	}

	return `across ${repos.length} repos`;
}

function group(kind: NotifyKind, events: Event[]): NotifySpec {
	return {
		kind,
		id: `${kind}|${DASHBOARD_URL}`,
		title: GROUP_HEADLINE[kind](events.length),
		message: groupDetail(events),
		action: 'Open PR Pulse',
		url: DASHBOARD_URL,
	};
}

const MIN_STALE_MS = 30 * 60 * 1000;

/** A cache this old would announce every change since, so it is refreshed silently instead. */
export function isStaleCache(lastFetched: number | null, now: number, pollingIntervalMs: number): boolean {
	return lastFetched !== null && now - lastFetched > Math.max(3 * pollingIntervalMs, MIN_STALE_MS);
}

/**
 * The diff, as notifications: one per changed PR. With `grouped`, several changes of the same kind in
 * one refresh collapse into a single count instead — a morning's backlog as one line, not fifteen.
 */
export function notificationsFor(
	previous: PullRequestData,
	next: PrSourceResult,
	me: string,
	states: Map<string, string> = new Map(),
	grouped = false,
): NotifySpec[] {
	// Nothing to diff against: a fresh install, or the first poll after a reset. Every open PR would
	// otherwise announce itself at once.
	if (previous.lastFetched === null || !me) {
		return [];
	}

	const events = collectEvents(previous, next, me, previous.lastFetched, states);
	if (!grouped) {
		return events.map(single);
	}

	const byKind = new Map<NotifyKind, Event[]>();

	for (const event of events) {
		const bucket = byKind.get(event.kind);
		if (bucket) {
			bucket.push(event);
		} else {
			byKind.set(event.kind, [event]);
		}
	}

	return Array.from(byKind, ([kind, bucket]) => (bucket.length > 1 ? group(kind, bucket) : single(bucket[0])));
}

function single(event: Event): NotifySpec {
	return {
		kind: event.kind,
		id: `${event.kind}|${event.url}`,
		title: event.title,
		message: event.message,
		action: event.action,
		detail: sizeOf(event.pr),
		url: event.url,
	};
}
