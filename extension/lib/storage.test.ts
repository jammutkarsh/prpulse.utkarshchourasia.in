import assert from 'node:assert/strict';
import { createMemoryStore, createStorage } from './storage-core';
import { DEFAULT_SETTINGS } from './ui-config';

// The second adapter at the KeyValueStore seam. Its whole point is that this file can run in node:
// before storage took its store as a parameter, nothing here was reachable outside a browser.
// Run with: npm test

async function testDefaultsOnEmptyStore(): Promise<void> {
	const storage = createStorage(createMemoryStore());

	// An empty store reads as defaults, not undefined — every caller assumes a whole Settings.
	assert.deepEqual(await storage.getSettings(), DEFAULT_SETTINGS);
	assert.deepEqual(await storage.getPullRequests(), { myPRs: [], reviewRequests: [], lastFetched: null });
	assert.equal(await storage.getProvider(), undefined);
	assert.equal(await storage.isAuthenticated(), false);
}

async function testBootstrapMatchesTheIndividualReads(): Promise<void> {
	const storage = createStorage(createMemoryStore());
	await storage.setSettings({ pinnedTab: 'toReview' });
	await storage.setPullRequests({ myPRs: [], reviewRequests: [] });

	// One read, same answers as the per-key reads — the two bespoke bootstrap methods this replaced
	// each carried their own copy of the empty-PullRequestData default.
	const bootstrap = await storage.getBootstrapData();
	assert.deepEqual(bootstrap.settings, await storage.getSettings());
	assert.deepEqual(bootstrap.pullRequests, await storage.getPullRequests());
	assert.equal(bootstrap.provider, undefined);
	assert.deepEqual(await storage.getBootstrapData(), { ...bootstrap, pullRequests: bootstrap.pullRequests });
}

async function testSettingsMerge(): Promise<void> {
	const storage = createStorage(createMemoryStore());

	// Read-merge-write: a partial write must not drop the keys it does not mention.
	await storage.setSettings({ pinnedTab: 'toReview' });
	await storage.setSettings({ badgeCountMode: 'filters' });
	const settings = await storage.getSettings();
	assert.equal(settings.pinnedTab, 'toReview');
	assert.equal(settings.badgeCountMode, 'filters');
	assert.equal(settings.pollingIntervalMs, DEFAULT_SETTINGS.pollingIntervalMs);
}

async function testFiltersRoundTripAndClear(): Promise<void> {
	const storage = createStorage(createMemoryStore());
	const filters = await storage.getFilters('myPRs');
	filters.myPRs.repos = ['acme/api'];

	await storage.setFilters(filters);
	assert.deepEqual((await storage.getFilters('myPRs')).myPRs.repos, ['acme/api']);

	await storage.clearFilters();
	assert.deepEqual((await storage.getFilters('myPRs')).myPRs.repos, []);
}

async function testAuthenticatedNeedsTokenAndUser(): Promise<void> {
	const storage = createStorage(createMemoryStore());

	await storage.setProvider({ type: 'github', token: 'ghp_x' });
	assert.equal(await storage.isAuthenticated(), false, 'a token without a user is not authenticated');

	await storage.setProvider({ type: 'github', token: 'ghp_x', user: { login: 'ada', name: 'Ada', avatarUrl: '' } });
	assert.equal(await storage.isAuthenticated(), true);

	await storage.clearAll();
	assert.equal(await storage.isAuthenticated(), false);
}

// A partial first-sync write must keep `lastFetched` null: notifications read null as "nothing to diff
// against", which is what stops a first sync that died halfway from announcing every PR next poll.
async function testPartialWritesStayUnfetched(): Promise<void> {
	const storage = createStorage(createMemoryStore());

	await storage.setPartialPullRequests({ myPRs: [], reviewRequests: [] });
	assert.equal((await storage.getPullRequests()).lastFetched, null);

	await storage.setPullRequests({ myPRs: [], reviewRequests: [] });
	assert.notEqual((await storage.getPullRequests()).lastFetched, null);

	const status = { inProgress: true, loaded: 1, total: 2, startedAt: 1 };
	await storage.setSyncStatus(status);
	assert.deepEqual((await storage.getBootstrapData()).syncStatus, status);
}

await testPartialWritesStayUnfetched();
await testDefaultsOnEmptyStore();
await testBootstrapMatchesTheIndividualReads();
await testSettingsMerge();
await testFiltersRoundTripAndClear();
await testAuthenticatedNeedsTokenAndUser();
console.log('storage: all checks passed');
