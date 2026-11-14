import assert from 'node:assert/strict';
import { activeSync, createPopupSession, STALE_SYNC_MS, TOKEN_EXPIRED_MESSAGE } from './popup-session';
import { createMemoryStore, createStorage } from './storage-core';
import { createDefaultFiltersByTab } from './pr-view';
import type { PullRequest, RuntimeMessage } from './types';

// The popup's bootstrap order, its new-PR count and its filter writes used to live in a .svelte file,
// out of reach. They run here over the in-memory adapter instead. Run with: npm test

function pr(id: string, login = 'ada'): PullRequest {
	return {
		id,
		provider: 'github',
		number: Number(id) || 1,
		title: `PR ${id}`,
		url: `https://github.com/acme/api/pull/${id}`,
		repoFullName: 'acme/api',
		repoOwner: { login: 'acme', type: 'org' },
		branchName: `feat/${id}`,
		author: { login, avatarUrl: '', name: login },
		state: 'open',
		changes: { additions: 1, deletions: 0, filesChanged: 1 },
		checks: { status: 'success' },
		reviews: { status: 'pending', reviewers: [] },
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		isDraft: false,
	};
}

const connectedProvider = { type: 'github' as const, token: 'ghp_x', user: { login: 'ada', name: 'Ada', avatarUrl: '' } };

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sessionOver(seed: Record<string, unknown>, respond: (message: RuntimeMessage) => unknown = () => ({ success: true })) {
	const storage = createStorage(createMemoryStore(seed));
	const sent: RuntimeMessage[] = [];
	const session = createPopupSession({
		storage,
		sendMessage: async (message) => {
			sent.push(message);
			return respond(message);
		},
	});

	return { storage, session, sent };
}

async function testSetupRequiredLeavesStorageAlone(): Promise<void> {
	const { session, storage } = sessionOver({});
	await session.open();
	await flush();

	assert.equal(session.getState().setupRequired, true);
	assert.equal(session.getState().loading, false);
	// Nothing to filter and nobody connected: the filter key stays untouched.
	assert.deepEqual(await storage.getFilters('myPRs'), createDefaultFiltersByTab());
}

async function testRestoresFiltersOnlyWhenAsked(): Promise<void> {
	const stored = { tabs: { myPRs: { repos: ['acme/api'] } } };

	const remembering = sessionOver({
		provider: connectedProvider,
		settings: { persistFilters: true, pinnedTab: 'myPRs' },
		searchFilters: stored,
	});
	await remembering.session.open();
	assert.deepEqual(remembering.session.getState().filters.repos, ['acme/api']);

	// Per-session mode starts clean — and writes that clean state, because the worker sizes the badge
	// from this key and would otherwise keep counting through filters the popup has already dropped.
	const perSession = sessionOver({
		provider: connectedProvider,
		settings: { persistFilters: false, pinnedTab: 'myPRs' },
		searchFilters: stored,
	});
	await perSession.session.open();
	await flush();

	assert.deepEqual(perSession.session.getState().filters.repos, []);
	assert.deepEqual((await perSession.storage.getFilters('myPRs')).myPRs.repos, []);
}

async function testFilterWritesReachDisk(): Promise<void> {
	const { session, storage } = sessionOver({
		provider: connectedProvider,
		settings: { persistFilters: false, pinnedTab: 'toReview' },
	});
	await session.open();

	const filters = { ...session.getState().filters, authors: ['ada'] };
	session.setFilters(filters);
	await flush();

	assert.deepEqual((await storage.getFilters('toReview')).toReview.authors, ['ada']);

	// An identical set is not a change: no state churn, so no write and no badge recompute.
	const before = session.getState();
	session.setFilters({ ...filters, authors: ['ada'] });
	assert.equal(session.getState(), before);
}

async function testTabSwitchStashesFilters(): Promise<void> {
	const { session, storage } = sessionOver({
		provider: connectedProvider,
		settings: { persistFilters: true, pinnedTab: 'myPRs' },
	});
	await session.open();

	session.setFilters({ ...session.getState().filters, repos: ['acme/api'] });
	session.setTab('toReview');
	await flush();

	assert.equal(session.getState().tab, 'toReview');
	assert.deepEqual(session.getState().filters.repos, []);

	const onDisk = await storage.getFilters('myPRs');
	assert.deepEqual(onDisk.myPRs.repos, ['acme/api']);
	assert.deepEqual(onDisk.toReview.repos, []);
}

async function testNewPrCount(): Promise<void> {
	const { session } = sessionOver({
		provider: connectedProvider,
		settings: {},
		pullRequests: { myPRs: [pr('1')], reviewRequests: [], lastFetched: 1 },
	});
	await session.open();

	assert.equal(session.getState().newPrCount, 0);

	session.applyPullRequests({ myPRs: [pr('1'), pr('2')], reviewRequests: [pr('3')], lastFetched: 2 });
	assert.equal(session.getState().newPrCount, 2);

	// Already-seen PRs never become new again, however often the worker rewrites them.
	session.applyPullRequests({ myPRs: [pr('1')], reviewRequests: [], lastFetched: 3 });
	assert.equal(session.getState().newPrCount, 0);

	// A partial first-sync write has no baseline to be new against.
	session.applyPullRequests({ myPRs: [pr('1'), pr('9')], reviewRequests: [], lastFetched: null });
	assert.equal(session.getState().newPrCount, 0);
}

async function testRefreshSurfacesDeadToken(): Promise<void> {
	const { session, sent } = sessionOver({ provider: connectedProvider, settings: {} }, () => ({
		success: false,
		error: 'TOKEN_INVALID',
	}));
	await session.open();

	const result = await session.refresh();

	assert.deepEqual(sent, [{ type: 'REFRESH_PRS' }]);
	assert.equal(result.ok, false);
	assert.equal(session.getState().errorMessage, TOKEN_EXPIRED_MESSAGE);
}

async function testNotificationAnswerSticks(): Promise<void> {
	const { session, storage } = sessionOver({ provider: connectedProvider, settings: {} });
	await session.open();

	// Unanswered is what the popup prompts on, and either answer has to end that.
	assert.equal(session.getState().settings.notificationsEnabled, null);

	await session.setNotifications(false);

	assert.equal(session.getState().settings.notificationsEnabled, false);
	assert.equal((await storage.getSettings()).notificationsEnabled, false);
}

/** Declining the browser's own permission prompt has to land as off, not as an on setting that cannot fire. */
async function testDeclinedPermissionStoresOff(): Promise<void> {
	const storage = createStorage(createMemoryStore({ provider: connectedProvider, settings: {} }));
	const session = createPopupSession({
		storage,
		sendMessage: async () => ({ success: true }),
		requestNotificationPermission: async () => false,
	});
	await session.open();

	assert.equal(await session.setNotifications(true), false);
	assert.equal((await storage.getSettings()).notificationsEnabled, false);
}

async function testRefreshBlockedBeforeSetup(): Promise<void> {
	const { session, sent } = sessionOver({});
	await session.open();

	const result = await session.refresh();

	assert.equal(result.ok, false);
	assert.deepEqual(sent, []);
}

// The popup shows "Syncing" from what the worker left on disk. A worker killed mid-fetch never writes
// the finish, so an old in-progress status must read as no sync at all.
async function testSyncStatus(): Promise<void> {
	const now = Date.now();
	const running = { inProgress: true, loaded: 25, total: 155, startedAt: now - 1000 };

	assert.equal(activeSync(undefined, now), null);
	assert.equal(activeSync({ ...running, inProgress: false }, now), null);
	assert.deepEqual(activeSync(running, now), running);
	assert.equal(activeSync({ ...running, startedAt: now - STALE_SYNC_MS - 1 }, now), null);
	// A heartbeat keeps a slow sync alive; staleness counts from the last one.
	assert.deepEqual(activeSync({ ...running, startedAt: now - STALE_SYNC_MS - 1, updatedAt: now - 1000 }, now)?.loaded, 25);
	assert.equal(activeSync({ ...running, updatedAt: now - STALE_SYNC_MS - 1 }, now), null);

	// Opening mid-sync picks it up; the worker's later writes move it on and then clear it.
	const { session } = sessionOver({ provider: connectedProvider, syncStatus: running });
	await session.open();
	assert.deepEqual(session.getState().sync, running);

	session.applySyncStatus({ ...running, loaded: 50 });
	assert.equal(session.getState().sync?.loaded, 50);

	session.applySyncStatus({ ...running, inProgress: false });
	assert.equal(session.getState().sync, null);
}

await testSyncStatus();
await testSetupRequiredLeavesStorageAlone();
await testRestoresFiltersOnlyWhenAsked();
await testFilterWritesReachDisk();
await testTabSwitchStashesFilters();
await testNewPrCount();
await testRefreshSurfacesDeadToken();
await testNotificationAnswerSticks();
await testDeclinedPermissionStoresOff();
await testRefreshBlockedBeforeSetup();
console.log('popup-session: all checks passed');
