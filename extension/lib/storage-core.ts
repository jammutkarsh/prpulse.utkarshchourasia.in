// Store-agnostic on purpose, and in its own file for a load-bearing reason: webextension-polyfill
// throws on import outside a browser extension, so anything that reaches the extension's storage
// adapter cannot be loaded in node. Keeping the factory here is what makes `storage.test.ts` possible.

import type { FiltersByTab, PopupTab, PullRequestData, Settings, StoredFilterState, StoredProviderConfig, SyncStatus } from './types';
import { normalizeFilterState } from './pr-view';
import { normalizeSettings } from './ui-config';

export const STORAGE_KEYS = {
	PROVIDER: 'provider',
	PULL_REQUESTS: 'pullRequests',
	SETTINGS: 'settings',
	FILTERS: 'searchFilters',
	SYNC_STATUS: 'syncStatus',
} as const;

/**
 * Everything this module needs from a key-value store. Narrow on purpose: the extension's local
 * storage satisfies it in the browser, a Map satisfies it in `storage.test.ts`. Two adapters, so the
 * seam is real — before this, nothing could read or write settings outside a browser.
 */
export interface KeyValueStore {
	get(keys: string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string[]): Promise<void>;
	clear(): Promise<void>;
}

/**
 * The in-memory adapter at the seam. Lives beside the interface rather than inside a test file so the
 * storage and popup-session checks can share one, and so the seam ships with both of its adapters.
 */
export function createMemoryStore(seed: Record<string, unknown> = {}): KeyValueStore {
	const map = new Map(Object.entries(seed));

	return {
		async get(keys) {
			const result: Record<string, unknown> = {};
			for (const key of keys) {
				if (map.has(key)) {
					result[key] = map.get(key);
				}
			}
			return result;
		},
		async set(items) {
			for (const [key, value] of Object.entries(items)) {
				map.set(key, value);
			}
		},
		async remove(keys) {
			for (const key of keys) {
				map.delete(key);
			}
		},
		async clear() {
			map.clear();
		},
	};
}

function emptyPullRequestData(): PullRequestData {
	return { myPRs: [], reviewRequests: [], lastFetched: null };
}

export interface BootstrapData {
	settings: Settings;
	provider: StoredProviderConfig | undefined;
	pullRequests: PullRequestData;
	syncStatus: SyncStatus | undefined;
}

export function createStorage(store: KeyValueStore) {
	async function get<T>(key: string): Promise<T | undefined> {
		const result = await store.get([key]);
		return result[key] as T | undefined;
	}

	async function set<T>(key: string, value: T): Promise<void> {
		return store.set({ [key]: value });
	}

	async function getProvider(): Promise<StoredProviderConfig | undefined> {
		return get<StoredProviderConfig>(STORAGE_KEYS.PROVIDER);
	}

	async function setProvider(provider: StoredProviderConfig): Promise<void> {
		return set(STORAGE_KEYS.PROVIDER, provider);
	}

	async function getPullRequests(): Promise<PullRequestData> {
		return (await get<PullRequestData>(STORAGE_KEYS.PULL_REQUESTS)) || emptyPullRequestData();
	}

	async function setPullRequests(pullRequests: Omit<PullRequestData, 'lastFetched'> | PullRequestData): Promise<void> {
		return set(STORAGE_KEYS.PULL_REQUESTS, {
			...pullRequests,
			lastFetched: Date.now(),
		});
	}

	/**
	 * Part of a first sync, written so the popup has something to show while the rest loads.
	 * `lastFetched` stays null on purpose: notifications treat null as "nothing to diff against", so a
	 * first sync that dies halfway cannot make the next poll announce every PR it had not reached yet.
	 */
	async function setPartialPullRequests(pullRequests: Omit<PullRequestData, 'lastFetched'>): Promise<void> {
		return set(STORAGE_KEYS.PULL_REQUESTS, { ...pullRequests, lastFetched: null });
	}

	async function setSyncStatus(status: SyncStatus): Promise<void> {
		return set(STORAGE_KEYS.SYNC_STATUS, status);
	}

	async function getSettings(): Promise<Settings> {
		return normalizeSettings(await get<Partial<Settings>>(STORAGE_KEYS.SETTINGS));
	}

	/** One read for everyone who starts up. Both the popup and the worker needed a bespoke method before. */
	async function getBootstrapData(): Promise<BootstrapData> {
		const result = await store.get([
			STORAGE_KEYS.SETTINGS,
			STORAGE_KEYS.PROVIDER,
			STORAGE_KEYS.PULL_REQUESTS,
			STORAGE_KEYS.SYNC_STATUS,
		]);

		return {
			settings: normalizeSettings(result[STORAGE_KEYS.SETTINGS] as Partial<Settings> | undefined),
			provider: result[STORAGE_KEYS.PROVIDER] as StoredProviderConfig | undefined,
			pullRequests: (result[STORAGE_KEYS.PULL_REQUESTS] as PullRequestData | undefined) || emptyPullRequestData(),
			syncStatus: result[STORAGE_KEYS.SYNC_STATUS] as SyncStatus | undefined,
		};
	}

	/** Read-merge-write. `updateSetting(key, value)` was the same thing with one key, so it is gone. */
	async function setSettings(settings: Partial<Settings>): Promise<void> {
		const current = await getSettings();
		return set(STORAGE_KEYS.SETTINGS, { ...current, ...settings });
	}

	/** Both readers — popup and badge — go through this, so both see normalized, legacy-aware filters. */
	async function getFilters(fallbackTab: PopupTab): Promise<FiltersByTab> {
		return normalizeFilterState(await get<StoredFilterState>(STORAGE_KEYS.FILTERS), fallbackTab);
	}

	async function setFilters(filters: FiltersByTab): Promise<void> {
		return set(STORAGE_KEYS.FILTERS, { tabs: filters } satisfies StoredFilterState);
	}

	async function clearFilters(): Promise<void> {
		return store.remove([STORAGE_KEYS.FILTERS]);
	}

	async function isAuthenticated(): Promise<boolean> {
		const provider = await getProvider();
		return !!(provider && provider.token && provider.user);
	}

	async function clearAll(): Promise<void> {
		return store.clear();
	}

	return {
		getProvider,
		setProvider,
		getPullRequests,
		setPullRequests,
		setPartialPullRequests,
		setSyncStatus,
		getSettings,
		getBootstrapData,
		setSettings,
		getFilters,
		setFilters,
		clearFilters,
		isAuthenticated,
		clearAll,
	};
}
