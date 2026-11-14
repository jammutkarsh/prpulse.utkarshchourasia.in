import Fuse from 'fuse.js';
import { jiraTicketFor } from './jira';
import type {
	FiltersByTab,
	PopupAuthorFilterOption,
	PopupFilters,
	PopupOwnerFilterOption,
	PopupRepoFilterOption,
	PopupTab,
	PullRequest,
	Settings,
	StoredFilterState,
	StoredFilters,
} from './types';

// The popup, the website demo and the badge all need the same answer: given a tab's pull requests,
// a filter set and a search query, what is shown, what can still be filtered on, and how many
// filters are active. Every caller used to assemble that itself, and the copies drifted.

export interface FilterOptions<T> {
	/** Every option the tab offers, ignoring the other filters. Drives "is this filter worth showing?". */
	all: T[];
	/** Options that still match once the *other* filters are applied. Drives which rows are selectable. */
	available: T[];
}

export interface PrViewOptions {
	authors: FilterOptions<PopupAuthorFilterOption>;
	owners: FilterOptions<PopupOwnerFilterOption>;
	repos: FilterOptions<PopupRepoFilterOption>;
}

export interface PrView {
	items: PullRequest[];
	options: PrViewOptions;
	filterCount: number;
	/** The filters that were actually applied: the caller's, minus selections nothing can match. */
	filters: PopupFilters;
}

const DEFAULT_FILTERS: Readonly<PopupFilters> = Object.freeze({
	authors: [],
	owners: [],
	repos: [],
	ageRange: '',
	drafts: 'exclude',
	showReviewed: false,
	conflictsOnly: false,
});

export function createDefaultFilters(): PopupFilters {
	return { ...DEFAULT_FILTERS, authors: [], owners: [], repos: [] };
}

export function createDefaultFiltersByTab(): FiltersByTab {
	return { myPRs: createDefaultFilters(), toReview: createDefaultFilters() };
}

export function cloneFilters(filters: PopupFilters): PopupFilters {
	return {
		authors: [...filters.authors],
		owners: [...filters.owners],
		repos: [...filters.repos],
		ageRange: filters.ageRange,
		drafts: filters.drafts,
		showReviewed: filters.showReviewed,
		conflictsOnly: filters.conflictsOnly,
	};
}

function sameList(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Whether two filter sets would produce the same view. Callers use it to skip redundant writes. */
export function sameFilters(left: PopupFilters, right: PopupFilters): boolean {
	return (
		left.ageRange === right.ageRange &&
		left.drafts === right.drafts &&
		left.showReviewed === right.showReviewed &&
		left.conflictsOnly === right.conflictsOnly &&
		sameList(left.authors, right.authors) &&
		sameList(left.owners, right.owners) &&
		sameList(left.repos, right.repos)
	);
}

/**
 * Leaving a tab stashes the filters you were using there; arriving restores the target tab's.
 * Both surfaces switch tabs, so the stash rule is here rather than written out at each of them.
 */
export function switchTab(
	stash: FiltersByTab,
	from: PopupTab,
	active: PopupFilters,
	to: PopupTab,
): { stash: FiltersByTab; filters: PopupFilters } {
	const next: FiltersByTab = { ...stash, [from]: cloneFilters(active) };
	return { stash: next, filters: cloneFilters(next[to]) };
}

type FilterSubset = Partial<Pick<PopupFilters, 'authors' | 'owners' | 'repos' | 'drafts' | 'showReviewed' | 'conflictsOnly'>>;

// Conflicts block the merge whatever the reviewers think, but an approved PR stays green so the badge
// doesn't hide the finished review. The card and the conflicts filter share this so they never disagree.
export function hasMergeConflicts(pr: PullRequest): boolean {
	return pr.mergeable === 'conflicting' && pr.reviews?.status !== 'approved';
}

function ownerLoginOf(pr: PullRequest): string {
	return pr.repoOwner?.login || pr.repoFullName?.split('/')[0] || '';
}

function applyFilters(items: PullRequest[], filters: FilterSubset): PullRequest[] {
	let result = items;

	if (filters.drafts === 'exclude') {
		result = result.filter((pr) => !pr.isDraft);
	} else if (filters.drafts === 'only') {
		result = result.filter((pr) => pr.isDraft);
	}

	if (filters.authors?.length) {
		result = result.filter((pr) => filters.authors!.includes(pr.author?.login || ''));
	}

	if (filters.repos?.length) {
		result = result.filter((pr) => filters.repos!.includes(pr.repoFullName));
	}

	if (filters.owners?.length) {
		result = result.filter((pr) => filters.owners!.includes(ownerLoginOf(pr)));
	}

	if (filters.showReviewed === false) {
		result = result.filter((pr) => pr.reviews.status !== 'approved');
	}

	if (filters.conflictsOnly) {
		result = result.filter((pr) => hasMergeConflicts(pr));
	}

	return result;
}

function uniqueSorted<T>(entries: (readonly [string, T])[], compare: (left: T, right: T) => number): T[] {
	const list = Array.from(new Map(entries.filter(([key]) => Boolean(key))).values());
	list.sort(compare);
	return list;
}

function byText(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function getOwnersFromItems(items: PullRequest[]): PopupOwnerFilterOption[] {
	return uniqueSorted(
		items.map((pr) => {
			const login = ownerLoginOf(pr);
			return [login.toLowerCase(), { login, type: pr.repoOwner?.type || 'unknown' }] as const;
		}),
		(left, right) => byText(left.login, right.login),
	);
}

function getAuthorsFromItems(items: PullRequest[], isToReview: boolean): PopupAuthorFilterOption[] {
	// Authoring your own PRs makes the author filter meaningless on the "my PRs" tab.
	if (!isToReview) return [];

	return uniqueSorted(
		items.map((pr) => {
			const login = pr.author?.login || '';
			return [login.toLowerCase(), { login, name: pr.author?.name || login }] as const;
		}),
		(left, right) => byText(left.login, right.login) || byText(left.name, right.name),
	);
}

function getReposFromItems(items: PullRequest[]): PopupRepoFilterOption[] {
	return uniqueSorted(
		items
			.filter((pr) => pr.repoFullName)
			.map((pr) => {
				const [owner = '', name = pr.repoFullName] = pr.repoFullName.split('/');
				const option: PopupRepoFilterOption = {
					fullName: pr.repoFullName,
					owner,
					ownerType: pr.repoOwner?.type || 'unknown',
					name,
				};
				return [pr.repoFullName, option] as const;
			}),
		(left, right) => byText(left.name, right.name) || byText(left.owner, right.owner),
	);
}

function searchItems(items: PullRequest[], query: string): PullRequest[] {
	// The Jira ticket is grafted on so a branch like `feat/ABC-123-thing` is findable by ticket id.
	// ponytail: index is rebuilt per keystroke; memoize if a popup ever holds thousands of PRs.
	type Searchable = PullRequest & { _jiraTicket: string };
	const index = new Fuse<Searchable>(
		items.map((pr) => ({ ...pr, _jiraTicket: jiraTicketFor(pr.branchName) })),
		{ keys: ['title', 'branchName', 'repoFullName', '_jiraTicket'], threshold: 0.3, ignoreLocation: true },
	);

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	return index.search(query).map(({ item: { _jiraTicket, ...pr } }) => pr);
}

export function countActiveFilters(filters: PopupFilters, tab: PopupTab): number {
	// Age filter is temporarily disabled. Restore `Number(Boolean(filters.ageRange))` when re-enabling it.
	return (
		filters.authors.length +
		filters.owners.length +
		filters.repos.length +
		(filters.drafts !== DEFAULT_FILTERS.drafts ? 1 : 0) +
		(filters.showReviewed && tab === 'toReview' ? 1 : 0) +
		(filters.conflictsOnly ? 1 : 0)
	);
}

/**
 * An option list is built from the *other* axes' filters, so anything missing from `available` is a
 * choice the rest of the filter set has already ruled out — selecting it can only ever match nothing.
 * Dropping those here, rather than in the surface that draws the checkboxes, is what stops a stale
 * selection from emptying the list with no visible row left to untick.
 */
function keepSelectable<T>(selected: string[], available: T[], idOf: (option: T) => string): string[] {
	if (selected.length === 0) {
		return selected;
	}

	const ids = new Set(available.map(idOf));
	const kept = selected.filter((id) => ids.has(id));
	return kept.length === selected.length ? selected : kept;
}

export function createPrView(items: PullRequest[], filters: PopupFilters, query: string, tab: PopupTab): PrView {
	const isToReview = tab === 'toReview';
	// Drafts are decided first: every option list is drawn from what the draft filter leaves behind.
	const pool = applyFilters(items, { drafts: filters.drafts });
	const { authors, owners, repos } = filters;

	const options: PrViewOptions = {
		authors: {
			all: getAuthorsFromItems(pool, isToReview),
			available: getAuthorsFromItems(applyFilters(pool, { owners, repos }), isToReview),
		},
		owners: {
			all: getOwnersFromItems(pool),
			available: getOwnersFromItems(applyFilters(pool, { authors, repos })),
		},
		repos: {
			all: getReposFromItems(pool),
			available: getReposFromItems(applyFilters(pool, { authors, owners })),
		},
	};

	const applied: PopupFilters = {
		...filters,
		authors: keepSelectable(authors, options.authors.available, (author) => author.login),
		owners: keepSelectable(owners, options.owners.available, (owner) => owner.login),
		repos: keepSelectable(repos, options.repos.available, (repo) => repo.fullName),
	};

	const showReviewed = isToReview ? applied.showReviewed : undefined;
	const filtered = applyFilters(pool, {
		authors: applied.authors,
		owners: applied.owners,
		repos: applied.repos,
		showReviewed,
		conflictsOnly: applied.conflictsOnly,
	});

	return {
		items: query.trim() ? searchItems(filtered, query) : filtered,
		options,
		filterCount: countActiveFilters(applied, tab),
		filters: applied,
	};
}

/**
 * What number goes on the badge. The pinned tab decides the list — never the tab the popup happens to
 * be showing — and an active filter narrows it; no active filter means the total, even in filters mode.
 *
 * Both the service worker and the popup need this answer, from different filter sources: the worker
 * reads what is on disk, the popup holds filters that may never be persisted. Same rule, one place;
 * the two hand-written copies had already drifted apart on that last point.
 */
export function badgeCount(
	data: { myPRs?: PullRequest[]; reviewRequests?: PullRequest[] },
	settings: Pick<Settings, 'pinnedTab' | 'badgeCountMode'>,
	filters: FiltersByTab,
): number {
	const items = (settings.pinnedTab === 'myPRs' ? data.myPRs : data.reviewRequests) || [];
	if (settings.badgeCountMode !== 'filters') {
		return items.length;
	}

	const view = createPrView(items, filters[settings.pinnedTab], '', settings.pinnedTab);
	return view.filterCount > 0 ? view.items.length : items.length;
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeFilters(value: StoredFilters | undefined): PopupFilters {
	const stored = value ?? {};

	return {
		authors: toStringArray(stored.authors),
		owners: toStringArray(stored.owners),
		repos: toStringArray(stored.repos),
		ageRange: typeof stored.ageRange === 'string' ? stored.ageRange : DEFAULT_FILTERS.ageRange,
		drafts: stored.drafts === 'only' || stored.drafts === 'include' ? stored.drafts : DEFAULT_FILTERS.drafts,
		showReviewed: typeof stored.showReviewed === 'boolean' ? stored.showReviewed : DEFAULT_FILTERS.showReviewed,
		conflictsOnly: stored.conflictsOnly === true,
	};
}

/** Handles both the current per-tab shape and the legacy single `activeFilters` blob. */
export function normalizeFilterState(value: StoredFilterState | undefined, fallbackTab: PopupTab): FiltersByTab {
	if (value?.tabs) {
		return {
			myPRs: normalizeFilters(value.tabs.myPRs),
			toReview: normalizeFilters(value.tabs.toReview),
		};
	}

	if (value?.activeFilters) {
		return { ...createDefaultFiltersByTab(), [fallbackTab]: normalizeFilters(value.activeFilters) };
	}

	return createDefaultFiltersByTab();
}
