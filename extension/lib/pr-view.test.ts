import assert from 'node:assert/strict';
import {
	badgeCount,
	countActiveFilters,
	createDefaultFilters,
	createDefaultFiltersByTab,
	createPrView,
	normalizeFilterState,
	sameFilters,
	switchTab,
} from './pr-view';
import type { PullRequest } from './types';

// This module is the one place the popup, the website demo and the badge agree on what "shown" and
// "filtered" mean. When they each had their own copy the counts diverged, so the rules get a check.
// Run with: npm test

function pr(overrides: Partial<PullRequest> & { id: string }): PullRequest {
	return {
		provider: 'github',
		number: 1,
		title: 'title',
		url: 'https://example.test/pr',
		repoFullName: 'acme/api',
		repoOwner: { login: 'acme', type: 'org' },
		branchName: 'feat/ABC-123-thing',
		author: { login: 'ada', name: 'Ada', avatarUrl: '' },
		state: 'open',
		changes: { additions: 0, deletions: 0, filesChanged: 0 },
		checks: { status: 'unknown' },
		reviews: { status: 'pending', reviewers: [] },
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		isDraft: false,
		...overrides,
	};
}

const items = [
	pr({ id: '1' }),
	pr({ id: '2', isDraft: true }),
	pr({
		id: '3',
		repoFullName: 'globex/web',
		repoOwner: { login: 'globex', type: 'org' },
		author: { login: 'bob', name: 'Bob', avatarUrl: '' },
	}),
	pr({ id: '4', reviews: { status: 'approved', reviewers: [] } }),
];

function ids(list: PullRequest[]): string[] {
	return list.map((item) => item.id);
}

function testDraftsGateEverything(): void {
	const filters = createDefaultFilters();

	// Default hides drafts, and the option lists are drawn from what is left.
	const view = createPrView(items, filters, '', 'myPRs');
	assert.deepEqual(ids(view.items), ['1', '3', '4']);
	assert.deepEqual(
		view.options.owners.all.map((owner) => owner.login),
		['acme', 'globex'],
	);

	assert.deepEqual(ids(createPrView(items, { ...filters, drafts: 'only' }, '', 'myPRs').items), ['2']);
	assert.deepEqual(ids(createPrView(items, { ...filters, drafts: 'include' }, '', 'myPRs').items), ['1', '2', '3', '4']);
}

function testTabConditionals(): void {
	const filters = createDefaultFilters();

	// Authors are only a meaningful filter on the review tab, and only there does showReviewed apply.
	assert.equal(createPrView(items, filters, '', 'myPRs').options.authors.all.length, 0);
	assert.deepEqual(
		createPrView(items, filters, '', 'toReview').options.authors.all.map((a) => a.login),
		['ada', 'bob'],
	);

	// showReviewed false drops the approved PR — on the review tab only.
	assert.deepEqual(ids(createPrView(items, filters, '', 'toReview').items), ['1', '3']);
	assert.deepEqual(ids(createPrView(items, { ...filters, showReviewed: true }, '', 'toReview').items), ['1', '3', '4']);
	assert.deepEqual(ids(createPrView(items, { ...filters, showReviewed: true }, '', 'myPRs').items), ['1', '3', '4']);
}

function testAvailableOptionsExcludeOwnAxis(): void {
	// Picking a repo must not shrink the repo list itself, or you could never switch selection.
	const view = createPrView(items, { ...createDefaultFilters(), repos: ['acme/api'] }, '', 'toReview');
	assert.deepEqual(
		view.options.repos.available.map((repo) => repo.fullName),
		['acme/api', 'globex/web'],
	);
	assert.deepEqual(
		view.options.authors.available.map((author) => author.login),
		['ada'],
	);
}

function testFilterCount(): void {
	const filters = createDefaultFilters();

	// The default state is zero active filters, drafts:'exclude' included.
	assert.equal(countActiveFilters(filters, 'myPRs'), 0);
	assert.equal(countActiveFilters({ ...filters, drafts: 'include' }, 'myPRs'), 1);
	assert.equal(countActiveFilters({ ...filters, authors: ['ada'], repos: ['acme/api'] }, 'toReview'), 2);

	// showReviewed counts only where it has an effect.
	assert.equal(countActiveFilters({ ...filters, showReviewed: true }, 'toReview'), 1);
	assert.equal(countActiveFilters({ ...filters, showReviewed: true }, 'myPRs'), 0);
}

function testSearch(): void {
	const filters = createDefaultFilters();

	// Branch names carry the Jira ticket, so the ticket id has to be searchable.
	assert.deepEqual(ids(createPrView(items, filters, 'ABC-123', 'myPRs').items), ['1', '3', '4']);
	assert.deepEqual(ids(createPrView(items, filters, 'globex', 'myPRs').items), ['3']);

	// A whitespace-only query is not a search.
	assert.deepEqual(ids(createPrView(items, filters, '   ', 'myPRs').items), ['1', '3', '4']);
}

function testNormalizeFilterState(): void {
	// The legacy single-blob shape must land on the fallback tab, not be ignored — the badge used to
	// read this raw and silently fall back to the total count.
	const legacy = normalizeFilterState({ activeFilters: { repos: ['acme/api'] } }, 'toReview');
	assert.deepEqual(legacy.toReview.repos, ['acme/api']);
	assert.deepEqual(legacy.myPRs, createDefaultFilters());

	// Garbage on disk normalizes to defaults rather than crashing a reader.
	const junk = normalizeFilterState({ tabs: { myPRs: { repos: 'nope' as unknown as string[], drafts: 'bogus' as never } } }, 'myPRs');
	assert.deepEqual(junk.myPRs, createDefaultFilters());
	assert.deepEqual(normalizeFilterState(undefined, 'myPRs').myPRs, createDefaultFilters());
}

function testBadgeCount(): void {
	const data = { myPRs: [pr({ id: '1' }), pr({ id: '2' })], reviewRequests: [pr({ id: '3' })] };
	const filters = createDefaultFiltersByTab();

	// 'total' mode ignores filters entirely, even active ones.
	assert.equal(badgeCount(data, { pinnedTab: 'myPRs', badgeCountMode: 'total' }, filters), 2);
	assert.equal(
		badgeCount(
			data,
			{ pinnedTab: 'myPRs', badgeCountMode: 'total' },
			{ ...filters, myPRs: { ...filters.myPRs, repos: ['nope/nope'] } },
		),
		2,
	);

	// The pinned tab decides the list, never the tab the popup is showing.
	assert.equal(badgeCount(data, { pinnedTab: 'toReview', badgeCountMode: 'total' }, filters), 1);

	// 'filters' mode with nothing active is still the total — this is the point the two hand-written
	// copies used to disagree on.
	assert.equal(badgeCount(data, { pinnedTab: 'myPRs', badgeCountMode: 'filters' }, filters), 2);

	// An active filter narrows it.
	const narrowed = { ...filters, myPRs: { ...filters.myPRs, repos: ['acme/api'] } };
	assert.equal(badgeCount(data, { pinnedTab: 'myPRs', badgeCountMode: 'filters' }, narrowed), 2);

	// A repo that is not in the data at all is a selection the popup itself would drop, so the badge
	// drops it too and falls back to the total. The badge showing 0 against a full list was the drift.
	const gone = { ...filters, myPRs: { ...filters.myPRs, repos: ['globex/web'] } };
	assert.equal(badgeCount(data, { pinnedTab: 'myPRs', badgeCountMode: 'filters' }, gone), 2);

	// A filter that is still selectable and still excludes everything counts what it excludes: zero.
	const noDrafts = { ...filters, myPRs: { ...filters.myPRs, drafts: 'only' as const } };
	assert.equal(badgeCount(data, { pinnedTab: 'myPRs', badgeCountMode: 'filters' }, noDrafts), 0);

	// Missing lists are empty lists, not a crash — storage can hold a half-written blob.
	assert.equal(badgeCount({}, { pinnedTab: 'myPRs', badgeCountMode: 'filters' }, filters), 0);
}

function testSwitchTab(): void {
	const stash = createDefaultFiltersByTab();
	const active = { ...createDefaultFilters(), repos: ['acme/api'] };

	// Leaving stashes what you were using; arriving restores the target tab's own set.
	const away = switchTab(stash, 'myPRs', active, 'toReview');
	assert.deepEqual(away.stash.myPRs.repos, ['acme/api']);
	assert.deepEqual(away.filters, createDefaultFilters());

	// Coming back returns the stashed set.
	const back = switchTab(away.stash, 'toReview', away.filters, 'myPRs');
	assert.deepEqual(back.filters.repos, ['acme/api']);

	// Stashed filters are copies: mutating the live set afterwards must not reach into the stash.
	active.repos.push('globex/web');
	assert.deepEqual(away.stash.myPRs.repos, ['acme/api']);
}

function testPrunesUnselectableFilters(): void {
	// bob only ever authors globex/web, so acme/api + bob is a pair that can never match together.
	// Each axis is judged against the others, so both go — one pass, the same rule the surface used.
	const stale = { ...createDefaultFilters(), repos: ['acme/api'], authors: ['bob'] };
	const view = createPrView(items, stale, '', 'toReview');

	assert.deepEqual(view.filters.authors, []);
	assert.deepEqual(view.filters.repos, []);
	// Pruned before filtering, so the tab shows its PRs instead of an empty list under dead filters.
	assert.deepEqual(ids(view.items), ['1', '3']);
	// And the count follows what was applied, not what was asked for.
	assert.equal(view.filterCount, 0);

	// Drafts gate the option lists, so flipping to drafts-only drops a selection they no longer offer —
	// and leaves the axis that is still live alone.
	const draftsOnly = createPrView(items, { ...createDefaultFilters(), drafts: 'only', repos: ['globex/web'] }, '', 'myPRs');
	assert.deepEqual(draftsOnly.filters.repos, []);
	assert.equal(draftsOnly.filters.drafts, 'only');
	assert.deepEqual(ids(draftsOnly.items), ['2']);

	// Author filters mean nothing on the "my PRs" tab, so a stashed one does not leak into it.
	assert.deepEqual(createPrView(items, { ...createDefaultFilters(), authors: ['bob'] }, '', 'myPRs').filters.authors, []);

	// A selection that still matches is left exactly as it was — pruning is idempotent.
	const live = { ...createDefaultFilters(), repos: ['globex/web'] };
	const applied = createPrView(items, live, '', 'toReview').filters;
	assert.equal(sameFilters(applied, live), true);
	assert.equal(sameFilters(createPrView(items, applied, '', 'toReview').filters, applied), true);
}

function testSameFilters(): void {
	const base = createDefaultFilters();
	assert.equal(sameFilters(base, createDefaultFilters()), true);
	assert.equal(sameFilters(base, { ...base, drafts: 'include' }), false);
	assert.equal(sameFilters({ ...base, repos: ['a'] }, { ...base, repos: ['a'] }), true);
	assert.equal(sameFilters({ ...base, repos: ['a'] }, { ...base, repos: ['a', 'b'] }), false);
}

testDraftsGateEverything();
testPrunesUnselectableFilters();
testSameFilters();
testTabConditionals();
testAvailableOptionsExcludeOwnAxis();
testFilterCount();
testSearch();
testNormalizeFilterState();
testBadgeCount();
// Only a confirmed conflict counts: GitHub computes mergeability lazily, so `unknown` is routine and
// says nothing about conflicts.
function testConflictsFilter(): void {
	const filters = createDefaultFilters();
	const mixed = [
		pr({ id: 'a', mergeable: 'conflicting' }),
		pr({ id: 'b', mergeable: 'mergeable' }),
		pr({ id: 'c', mergeable: 'unknown' }),
		pr({ id: 'd' }),
		pr({ id: 'e', mergeable: 'conflicting', isDraft: true }),
		// The card keeps an approved PR green, so the filter must not list it as conflicting either.
		pr({ id: 'f', mergeable: 'conflicting', reviews: { status: 'approved' } as PullRequest['reviews'] }),
	];
	const ids = (list: PullRequest[]) => list.map((item) => item.id);

	assert.deepEqual(ids(createPrView(mixed, filters, '', 'myPRs').items), ['a', 'b', 'c', 'd', 'f']);
	assert.deepEqual(ids(createPrView(mixed, { ...filters, conflictsOnly: true }, '', 'myPRs').items), ['a']);
	// Works on both tabs, combines with the draft filter, and counts as an active filter everywhere.
	assert.deepEqual(ids(createPrView(mixed, { ...filters, conflictsOnly: true, drafts: 'include' }, '', 'toReview').items), ['a', 'e']);
	assert.equal(countActiveFilters({ ...filters, conflictsOnly: true }, 'myPRs'), 1);
	assert.equal(countActiveFilters({ ...filters, conflictsOnly: true }, 'toReview'), 1);

	assert.equal(sameFilters(filters, { ...filters, conflictsOnly: true }), false);
	// Stored filters from before this option existed read as off.
	assert.equal(normalizeFilterState({ tabs: { myPRs: { drafts: 'include' } } }, 'myPRs').myPRs.conflictsOnly, false);
	assert.equal(normalizeFilterState({ tabs: { myPRs: { conflictsOnly: true } } }, 'myPRs').myPRs.conflictsOnly, true);
}

testSwitchTab();
testConflictsFilter();
console.log('pr-view: all checks passed');
