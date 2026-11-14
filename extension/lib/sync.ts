import { isAuthError } from './errors';
import type { createStorage } from './storage-core';
import type { PrSource, PrSourceResult, PullRequestData, StoredProviderConfig, SyncStatus } from './types';

// The worker's fetch, with everything it touches passed in so node can run it. The worker file itself
// imports the browser APIs and cannot be loaded outside an extension.

const HEARTBEAT_MS = 20_000;

export interface SyncDeps {
	storage: ReturnType<typeof createStorage>;
	makeSource: (provider: StoredProviderConfig) => PrSource;
	fetchWithRetry: <T>(fn: () => Promise<T>) => Promise<T>;
	refreshBadge: () => Promise<void>;
	notify: (source: PrSource, previous: PullRequestData, next: PrSourceResult) => Promise<void>;
	heartbeatMs?: number;
}

export async function runSync({ storage, makeSource, fetchWithRetry, refreshBadge, notify, heartbeatMs = HEARTBEAT_MS }: SyncDeps): Promise<void> {
	const provider = await storage.getProvider();
	if (!provider) {
		console.log('No provider configured, skipping fetch');
		throw new Error('No provider configured');
	}
	const source = makeSource(provider);
	// A reconnect or reset can land mid-fetch; results and errors from the old token must not touch the new state.
	const stillCurrent = async () => (await storage.getProvider())?.token === provider.token;

	const startedAt = Date.now();
	let status: SyncStatus = { inProgress: true, loaded: 0, total: 0, startedAt, updatedAt: startedAt };
	// Best-effort: a failed progress write must not turn a good fetch into a failed sync.
	const writeStatus = (next: SyncStatus) => storage.setSyncStatus(next).catch((error) => console.warn('Progress write failed:', error));
	// Writes from the progress callback, chained so they land in order and all before the final write.
	let progressWrites: Promise<unknown> = writeStatus(status);
	// Page requests can outlast the worker's idle timeout; a storage call every so often keeps it alive.
	const heartbeat = setInterval(() => {
		status = { ...status, updatedAt: Date.now() };
		progressWrites = progressWrites.then(() => writeStatus(status));
	}, heartbeatMs);

	try {
		console.log('Fetching PR data...');
		// Read before the overwrite: the previous poll's result is still on disk at this instant, which is
		// the whole reason notifications need no snapshot key of their own.
		const previous = await storage.getPullRequests();
		// Only a first sync shows PRs as they arrive. Afterwards the popup keeps the last complete list
		// until the new one is whole, rather than shrinking to page one and growing back on every poll.
		const firstSync = previous.lastFetched === null;

		const data = await fetchWithRetry(() =>
			source.getAllPullRequests((partial, progress) => {
				status = { inProgress: true, ...progress, startedAt, updatedAt: Date.now() };
				const written = status;
				progressWrites = progressWrites.then(async () => {
					if (firstSync && !(await stillCurrent())) return;
					await Promise.all([
						writeStatus(written),
						firstSync ? storage.setPartialPullRequests(partial).catch((error) => console.warn('Partial write failed:', error)) : null,
					]);
				});
			}),
		);
		await progressWrites;
		if (!(await stillCurrent())) {
			console.log('Provider changed during sync, discarding result');
			return;
		}
		await storage.setPullRequests(data);
		// A good fetch proves the token works, whatever an earlier failure flagged.
		if (provider.isTokenInvalid) {
			await storage.setProvider({ ...provider, isTokenInvalid: false });
		}
		await refreshBadge();
		await notify(source, previous, data);
		console.log(`Fetched ${data.myPRs.length} my PRs, ${data.reviewRequests.length} review requests`);
	} catch (error) {
		console.error('Failed to fetch PR data:', error);
		if (isAuthError(error)) {
			const config = await storage.getProvider();
			if (config && config.token === provider.token) {
				config.isTokenInvalid = true;
				await storage.setProvider(config);
			}
		}
		throw error;
	} finally {
		clearInterval(heartbeat);
		await progressWrites.catch(() => undefined);
		await storage
			.setSyncStatus({ inProgress: false, loaded: 0, total: 0, startedAt, updatedAt: Date.now() })
			.catch((error) => console.warn('Failed to clear sync status:', error));
	}
}

