import { cloneFilters, createDefaultFilters, createDefaultFiltersByTab, sameFilters, switchTab } from './pr-view';
import type { createStorage } from './storage-core';
import type {
	FiltersByTab,
	PopupFilters,
	PopupTab,
	PullRequestData,
	RuntimeMessage,
	Settings,
	StoredProviderConfig,
	SyncStatus,
} from './types';
import { DEFAULT_SETTINGS } from './ui-config';

// Everything the popup does that is not drawing: the bootstrap order, which filters get restored,
// what counts as a new PR, and when filters reach disk. It used to live as loose state and two
// effects inside the popup shell, where nothing in node could reach it.

type Storage = ReturnType<typeof createStorage>;
type SendMessage = (message: RuntimeMessage) => Promise<unknown>;

export const TOKEN_EXPIRED_MESSAGE = 'Token expired or revoked; Connect a new one.';

/**
 * Longer than any real sync. A worker killed mid-fetch never writes `inProgress: false`, and without a
 * cutoff the popup would show "Syncing" until the next poll finished.
 */
export const STALE_SYNC_MS = 5 * 60 * 1000;

/** The sync worth showing, or null when there is none or the one on disk was abandoned. */
export function activeSync(status: SyncStatus | undefined, now = Date.now()): SyncStatus | null {
	return status?.inProgress && now - (status.updatedAt ?? status.startedAt) < STALE_SYNC_MS ? status : null;
}

export interface PopupState {
	loading: boolean;
	setupRequired: boolean;
	errorMessage: string;
	provider: StoredProviderConfig | undefined;
	settings: Settings;
	pullRequests: PullRequestData;
	tab: PopupTab;
	filtersByTab: FiltersByTab;
	/** The active tab's filters — the same object the tab's entry in `filtersByTab` will be stashed as. */
	filters: PopupFilters;
	newPrCount: number;
	/** The worker's fetch, while one is running. */
	sync: SyncStatus | null;
}

export interface RefreshResult {
	ok: boolean;
	message: string;
}

export interface PopupSessionDeps {
	storage: Storage;
	sendMessage: SendMessage;
	/** Already-started bootstrap read, when the page kicked one off before the session existed. */
	bootstrap?: Promise<Awaited<ReturnType<Storage['getBootstrapData']>>> | null;
	/**
	 * Asks the browser for the optional `notifications` permission. Injected rather than imported so
	 * this module stays runnable in node; the default stands in for "nothing to ask".
	 */
	requestNotificationPermission?: () => Promise<boolean>;
}

function initialState(): PopupState {
	return {
		loading: true,
		setupRequired: false,
		errorMessage: '',
		provider: undefined,
		settings: DEFAULT_SETTINGS,
		pullRequests: { myPRs: [], reviewRequests: [], lastFetched: null },
		tab: 'myPRs',
		filtersByTab: createDefaultFiltersByTab(),
		filters: createDefaultFilters(),
		newPrCount: 0,
		sync: null,
	};
}

function idsOf(data: PullRequestData): string[] {
	return [...(data.myPRs || []), ...(data.reviewRequests || [])].map((pr) => pr.id);
}

export function createPopupSession({
	storage,
	sendMessage,
	bootstrap = null,
	requestNotificationPermission = async () => true,
}: PopupSessionDeps) {
	let state = initialState();
	let viewedPrIds = new Set<string>();
	const listeners = new Set<(next: PopupState) => void>();

	function set(patch: Partial<PopupState>): void {
		state = { ...state, ...patch };
		for (const listener of listeners) {
			listener(state);
		}
	}

	/**
	 * Filters always reach disk. `persistFilters` decides whether they are read back on the next open —
	 * it is not permission to write, because the worker reads this key to size the badge and would
	 * otherwise fall back to defaults the moment the popup closed. The trade: with `persistFilters`
	 * off the badge keeps counting through the last session's filters until the popup is opened again,
	 * which is the reading the user last saw — the old push reverted it to the total on the next poll.
	 */
	function persist(filtersByTab: FiltersByTab): void {
		void storage.setFilters(filtersByTab).catch((error) => {
			console.error('Failed to persist filter state:', error);
		});
	}

	async function open(): Promise<void> {
		const data = bootstrap ? await bootstrap : await storage.getBootstrapData();
		const provider = data.provider;
		const setupRequired = !(provider && provider.user && provider.token);
		const tab = data.settings.pinnedTab || 'myPRs';

		if (setupRequired) {
			set({
				loading: false,
				setupRequired: true,
				provider,
				settings: data.settings,
				tab,
				errorMessage: provider?.isTokenInvalid ? TOKEN_EXPIRED_MESSAGE : '',
			});
			return;
		}

		viewedPrIds = new Set(idsOf(data.pullRequests));

		// Restoring is the only thing `persistFilters` gates. Starting fresh still writes those fresh
		// filters, so what the badge is computed from matches what the popup is showing.
		const filtersByTab = data.settings.persistFilters ? await storage.getFilters(tab) : createDefaultFiltersByTab();
		if (!data.settings.persistFilters) {
			persist(filtersByTab);
		}

		set({
			loading: false,
			setupRequired: false,
			provider,
			settings: data.settings,
			pullRequests: data.pullRequests,
			sync: activeSync(data.syncStatus),
			tab,
			filtersByTab,
			filters: cloneFilters(filtersByTab[tab]),
			errorMessage: provider?.isTokenInvalid ? TOKEN_EXPIRED_MESSAGE : '',
		});
	}

	function setTab(tab: PopupTab): void {
		if (tab === state.tab) {
			return;
		}

		const switched = switchTab(state.filtersByTab, state.tab, state.filters, tab);
		persist(switched.stash);
		set({ tab, filtersByTab: switched.stash, filters: switched.filters });
	}

	/** Takes the filters the PR view actually applied, so a pruned selection is what gets stored. */
	function setFilters(filters: PopupFilters): void {
		if (sameFilters(filters, state.filters)) {
			return;
		}

		const filtersByTab: FiltersByTab = { ...state.filtersByTab, [state.tab]: cloneFilters(filters) };
		persist(filtersByTab);
		set({ filters, filtersByTab });
	}

	/**
	 * The popup's answer to the notifications prompt. Enabling has to clear the browser's own permission
	 * prompt first — a decline stores `false` just like "Not now", so neither prompt comes back. Stored
	 * either way, which is what ends the asking.
	 *
	 * Call this straight from the click handler: the permission request dies without the user gesture.
	 */
	async function setNotifications(enabled: boolean): Promise<boolean> {
		const granted = enabled ? await requestNotificationPermission() : false;

		set({ settings: { ...state.settings, notificationsEnabled: granted } });
		await storage.setSettings({ notificationsEnabled: granted });
		return granted;
	}

	/** A fresh write from the worker: whatever was not on screen when the popup opened counts as new. */
	function applyPullRequests(pullRequests: PullRequestData): void {
		// A partial first-sync list has no baseline: everything past page one would read as new.
		const newPrCount = viewedPrIds.size > 0 && pullRequests.lastFetched !== null ? idsOf(pullRequests).filter((id) => !viewedPrIds.has(id)).length : 0;
		set({ pullRequests, newPrCount });
	}

	function applySyncStatus(status: SyncStatus | undefined): void {
		set({ sync: activeSync(status) });
	}

	async function reload(): Promise<void> {
		set({ loading: true, errorMessage: '' });

		try {
			set({ loading: false, pullRequests: await storage.getPullRequests() });
		} catch (error) {
			console.error('Failed to load pull requests:', error);
			set({ loading: false, errorMessage: 'Failed to load pull requests' });
		}
	}

	async function refresh(): Promise<RefreshResult> {
		if (state.setupRequired) {
			return { ok: false, message: 'Setup required before refreshing PRs' };
		}

		try {
			const response = (await sendMessage({ type: 'REFRESH_PRS' })) as { success?: boolean; error?: string } | undefined;

			if (response?.success === false) {
				if (response.error === 'TOKEN_INVALID') {
					set({ errorMessage: TOKEN_EXPIRED_MESSAGE });
					return { ok: false, message: TOKEN_EXPIRED_MESSAGE };
				}

				throw new Error(response.error);
			}

			await reload();
			return { ok: true, message: 'PR data refreshed' };
		} catch (error) {
			console.error('Failed to refresh PRs:', error);
			return { ok: false, message: 'Failed to refresh PRs' };
		}
	}

	return {
		getState: () => state,
		subscribe(listener: (next: PopupState) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		open,
		setTab,
		setFilters,
		setNotifications,
		applyPullRequests,
		applySyncStatus,
		reload,
		refresh,
	};
}

export type PopupSession = ReturnType<typeof createPopupSession>;
