import assert from 'node:assert/strict';
import { runSync, type SyncDeps } from './sync';
import { createMemoryStore, createStorage } from './storage-core';
import type { PrSource, PrSourceResult, PullRequest } from './types';

// Run with: bun extension/lib/sync.test.ts

const pr = (id: string) => ({ id }) as unknown as PullRequest;
const result = (...ids: string[]): PrSourceResult => ({ myPRs: ids.map(pr), reviewRequests: [] });
const authError = Object.assign(new Error('Bad credentials'), { details: { statusCode: 401 } });

function setup(fetcher: (source: { token: string }, onProgress: Parameters<PrSource['getAllPullRequests']>[0]) => Promise<PrSourceResult>) {
	const storage = createStorage(createMemoryStore());
	const calls = { badge: 0, notify: 0 };
	const deps: SyncDeps = {
		storage,
		makeSource: (provider) => ({ getAllPullRequests: (onProgress) => fetcher({ token: provider.token }, onProgress) }),
		fetchWithRetry: (fn) => fn(),
		refreshBadge: async () => void calls.badge++,
		notify: async () => void calls.notify++,
	};
	return { storage, deps, calls };
}

async function testFirstSyncWritesPartialsThenFinishes(): Promise<void> {
	const { storage, deps, calls } = setup(async (_s, onProgress) => {
		onProgress?.(result('1'), { loaded: 1, total: 2 });
		await new Promise((r) => setTimeout(r, 0));
		// Mid-sync the partial list is on disk but still reads as "no first sync yet".
		assert.equal((await storage.getPullRequests()).myPRs.length, 1);
		assert.equal((await storage.getPullRequests()).lastFetched, null);
		return result('1', '2');
	});
	await storage.setProvider({ type: 'github', token: 'a' });

	await runSync(deps);

	const data = await storage.getPullRequests();
	assert.equal(data.myPRs.length, 2);
	assert.notEqual(data.lastFetched, null);
	assert.equal((await storage.getBootstrapData()).syncStatus?.inProgress, false);
	assert.deepEqual(calls, { badge: 1, notify: 1 });
}

async function testLaterSyncKeepsLastCompleteList(): Promise<void> {
	const { storage, deps } = setup(async (_s, onProgress) => {
		onProgress?.(result('9'), { loaded: 1, total: 2 });
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual((await storage.getPullRequests()).myPRs.map((p) => p.id), ['1']);
		return result('1', '9');
	});
	await storage.setProvider({ type: 'github', token: 'a' });
	await storage.setPullRequests(result('1'));

	await runSync(deps);
	assert.equal((await storage.getPullRequests()).myPRs.length, 2);
}

async function testAuthErrorOnlyFlagsTheTokenThatFailed(): Promise<void> {
	const { storage, deps } = setup(async () => {
		// The user reconnects with a new token while this sync is still on the old one.
		await storage.setProvider({ type: 'github', token: 'new' });
		throw authError;
	});
	await storage.setProvider({ type: 'github', token: 'old' });

	await assert.rejects(runSync(deps));
	assert.equal((await storage.getProvider())?.isTokenInvalid ?? false, false);
}

async function testAuthErrorFlagsCurrentToken(): Promise<void> {
	const { storage, deps } = setup(async () => {
		throw authError;
	});
	await storage.setProvider({ type: 'github', token: 'a' });

	await assert.rejects(runSync(deps));
	assert.equal((await storage.getProvider())?.isTokenInvalid, true);
	assert.equal((await storage.getBootstrapData()).syncStatus?.inProgress, false);
}

async function testSuccessClearsInvalidFlag(): Promise<void> {
	const { storage, deps } = setup(async () => result('1'));
	await storage.setProvider({ type: 'github', token: 'a', isTokenInvalid: true });

	await runSync(deps);
	assert.equal((await storage.getProvider())?.isTokenInvalid, false);
}

async function testResultDiscardedWhenProviderChanged(): Promise<void> {
	const { storage, deps, calls } = setup(async () => {
		await storage.setProvider({ type: 'github', token: 'new' });
		return result('1');
	});
	await storage.setProvider({ type: 'github', token: 'old' });

	await runSync(deps);
	assert.equal((await storage.getPullRequests()).lastFetched, null);
	assert.deepEqual(calls, { badge: 0, notify: 0 });
	assert.equal((await storage.getBootstrapData()).syncStatus?.inProgress, false);
}

async function testFailedProgressWriteDoesNotFailTheSync(): Promise<void> {
	const { storage, deps } = setup(async (_s, onProgress) => {
		onProgress?.(result('1'), { loaded: 1, total: 1 });
		return result('1');
	});
	await storage.setProvider({ type: 'github', token: 'a' });
	const realPartial = storage.setPartialPullRequests;
	storage.setPartialPullRequests = async () => {
		throw new Error('QUOTA_BYTES exceeded');
	};

	await runSync(deps);
	storage.setPartialPullRequests = realPartial;
	assert.notEqual((await storage.getPullRequests()).lastFetched, null);
}

async function testNoProviderThrows(): Promise<void> {
	const { deps } = setup(async () => result());
	await assert.rejects(runSync(deps), /No provider configured/);
}

async function testHeartbeatRefreshesStatus(): Promise<void> {
	const { storage, deps } = setup(async () => {
		await new Promise((r) => setTimeout(r, 40));
		const status = (await storage.getBootstrapData()).syncStatus;
		assert.equal(status?.inProgress, true);
		assert.ok((status?.updatedAt ?? 0) > status!.startedAt);
		return result('1');
	});
	await storage.setProvider({ type: 'github', token: 'a' });

	await runSync({ ...deps, heartbeatMs: 5 });
}

await testFirstSyncWritesPartialsThenFinishes();
await testLaterSyncKeepsLastCompleteList();
await testAuthErrorOnlyFlagsTheTokenThatFailed();
await testAuthErrorFlagsCurrentToken();
await testSuccessClearsInvalidFlag();
await testResultDiscardedWhenProviderChanged();
await testFailedProgressWriteDoesNotFailTheSync();
await testNoProviderThrows();
await testHeartbeatRefreshesStatus();
console.log('sync: all checks passed');
