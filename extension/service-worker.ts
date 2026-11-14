import { GitHubProvider } from './lib/providers/github-provider';
import {
	actionSetBadgeBackgroundColor,
	actionSetBadgeText,
	alarmsOnAlarmAddListener,
	alarmsClear,
	alarmsCreate,
	alarmsGet,
	notificationsClear,
	notificationsCreate,
	notificationsOnButtonClickedAddListener,
	notificationsAvailable,
	notificationsOnClickedAddListener,
	permissionsOnAddedAddListener,
	runtimeGetURL,
	runtimeOnInstalledAddListener,
	runtimeOnMessageAddListener,
	runtimeOnStartupAddListener,
	tabsCreate,
} from './lib/extension-api';
import { onFiltersChanged, storage } from './lib/storage';
import { badgeCount } from './lib/pr-view';
import { DASHBOARD_URL, notificationsFor } from './lib/pr-notify';
import { isAuthError } from './lib/errors';
import { runSync as runSyncWith } from './lib/sync';
import type { PrSource, PrSourceResult, PullRequestData, RuntimeMessage } from './lib/types';

const ALARM_NAME = 'pr-poll';

// No settings cache. MV3 tears this worker down between events, so a cache guards a local storage
// read that is already cheap, at the cost of three module-level variables five handlers had to
// invalidate by hand. Read on demand instead; storage is the single source.

async function fetchWithRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			const isNetworkError = error instanceof TypeError && error.message === 'Failed to fetch';
			if (!isNetworkError || attempt === maxRetries) {
				throw error;
			}
			const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
			console.log(`Fetch attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

// One sync at a time. A poll, the popup's refresh button and a token change can all ask at once; a
// second fetch would double the requests and race the first to the same storage keys, and two
// writers of the progress status would each mark it finished while the other was still running.
let syncInFlight: Promise<void> | null = null;

function syncPRs(): Promise<void> {
	syncInFlight ??= runSync().finally(() => {
		syncInFlight = null;
	});
	return syncInFlight;
}

async function fetchAndCachePRs(throwError = false): Promise<void> {
	try {
		await syncPRs();
	} catch (error) {
		if (throwError) throw error;
	}
}

function runSync(): Promise<void> {
	return runSyncWith({
		storage,
		makeSource: (provider) => new GitHubProvider({ token: provider.token, baseUrl: provider.baseUrl }),
		fetchWithRetry,
		refreshBadge,
		notify,
	});
}

/** The count itself is decided by the view module, so the popup and the badge cannot disagree. */
async function refreshBadge(): Promise<void> {
	const { settings, pullRequests } = await storage.getBootstrapData();
	// A first sync's partial list is not a count worth showing.
	if (pullRequests.lastFetched === null) {
		await updateBadge(0);
		return;
	}
	const filters = await storage.getFilters(settings.pinnedTab);
	await updateBadge(badgeCount(pullRequests, settings, filters));
}

/**
 * What changed, said out loud. The decision itself lives in `pr-notify`, which is pure and testable;
 * this only checks that the user still wants to hear it and hands the specs to the OS.
 *
 * Filters are not consulted, by design — see the note at the top of `pr-notify.ts`.
 */
async function notify(source: PrSource, previous: PullRequestData, next: PrSourceResult): Promise<void> {
	try {
		const { settings, provider } = await storage.getBootstrapData();
		if (!settings.notificationsEnabled) {
			return;
		}

		// `search` can only say a PR left `state:open`, not how — look the vanished ids up to tell merged
		// from closed. A failed lookup just means vaguer wording, never lost notifications.
		const stillOpen = new Set(next.myPRs.map((pr) => pr.id));
		const vanishedIds = previous.myPRs.filter((pr) => !stillOpen.has(pr.id)).map((pr) => pr.id);
		const states =
			vanishedIds.length && source.getStates
				? await source.getStates(vanishedIds).catch((error) => {
						console.warn('Failed to look up closed PR states:', error);
						return new Map<string, string>();
					})
				: new Map<string, string>();

		for (const spec of notificationsFor(previous, next, provider?.user?.login || '', states, settings.groupNotifications)) {
			await notificationsCreate(spec.id, spec);
		}
	} catch (error) {
		// A refresh that fetched fine has already done its job; a notification failure must not undo it.
		console.error('Failed to send notifications:', error);
	}
}

/** The click target rides in the notification id, so an MV3 teardown between firing and clicking loses nothing. */
async function openFromNotificationId(id: string): Promise<void> {
	const url = id.slice(id.indexOf('|') + 1);
	console.log('Notification clicked:', id);
	await tabsCreate({ url: url === DASHBOARD_URL ? runtimeGetURL(DASHBOARD_URL) : url });
	await notificationsClear(id);
}

let notificationListenersRegistered = false;

/**
 * `notifications` is optional, so at worker load the namespace may not exist yet and both calls are
 * no-ops. Granting it from the popup fires `permissions.onAdded`, which is the only chance to wire
 * clicks up without waiting for the next worker start.
 */
function registerNotificationListeners(): void {
	// `permissions.onAdded` can fire for any optional permission, and re-adding here would leave two
	// listeners racing to open the same tab twice.
	if (notificationListenersRegistered || !notificationsAvailable()) {
		return;
	}
	notificationListenersRegistered = true;

	notificationsOnClickedAddListener(openFromNotificationId);

	notificationsOnButtonClickedAddListener((id, buttonIndex) => {
		// Button 1 is Dismiss. Clearing is the whole action.
		if (buttonIndex === 1) {
			return notificationsClear(id).then(() => undefined);
		}

		return openFromNotificationId(id);
	});
}

registerNotificationListeners();
permissionsOnAddedAddListener(registerNotificationListeners);

async function updateBadge(count: number): Promise<void> {
	const text = count > 0 ? String(count) : '';
	await Promise.all([actionSetBadgeText({ text }), actionSetBadgeBackgroundColor({ color: '#238636' })]);
}

async function setupPollingAlarm(forceRecreate = false): Promise<void> {
	const settings = await storage.getSettings();

	// Manual refresh mode — clear any existing alarm and stop
	if (!settings.pollingIntervalMs) {
		await alarmsClear(ALARM_NAME);
		console.log('Manual refresh mode: polling alarm cleared');
		return;
	}

	if (!forceRecreate) {
		const existing = await alarmsGet(ALARM_NAME);
		if (existing) {
			console.log('Polling alarm already exists, skipping recreation');
			return;
		}
	}

	const intervalMinutes = settings.pollingIntervalMs / 60000;
	await alarmsClear(ALARM_NAME);
	alarmsCreate(ALARM_NAME, {
		delayInMinutes: Math.max(1, intervalMinutes),
		periodInMinutes: Math.max(1, intervalMinutes),
	});
	console.log(`Polling alarm set for every ${intervalMinutes} minute(s)`);
}

runtimeOnInstalledAddListener(async (details) => {
	console.log('Extension installed/updated:', details.reason);
	if (details.reason === 'install') {
		const onboardingUrl = runtimeGetURL('onboarding/onboarding.html');
		await tabsCreate({ url: onboardingUrl });
		return;
	}

	await fetchAndCachePRs();
	await setupPollingAlarm(true);
});

runtimeOnStartupAddListener(async () => {
	await refreshBadge();
	await fetchAndCachePRs();
	await setupPollingAlarm(true);
});

// The popup writes its filters on every change, so watching the key keeps the badge in step with an
// open popup. One writer, one input — the popup no longer pushes a count of its own.
onFiltersChanged(() => {
	void refreshBadge();
});

alarmsOnAlarmAddListener(async (alarm) => {
	if (alarm.name === ALARM_NAME) {
		console.log('Polling alarm triggered');
		await fetchAndCachePRs();
	}
});

runtimeOnMessageAddListener(async (message) => {
	try {
		return await handleMessage(message as RuntimeMessage);
	} catch (error) {
		console.error('Error handling runtime message:', error);
		const errorMessage = error instanceof Error ? error.message : String(error);
		return { success: false, error: errorMessage };
	}
});

const messageHandlers: Record<RuntimeMessage['type'], (message: RuntimeMessage) => Promise<unknown>> = {
	// Answers before the first fetch finishes: with many PRs that fetch takes tens of seconds, and both
	// onboarding and settings wait on this reply. The popup follows the fetch through `syncStatus`.
	// A sync already running was started with the previous token, so this one queues behind it rather
	// than joining it.
	PROVIDER_CONFIGURED: async () => {
		await setupPollingAlarm(true);
		void (syncInFlight ?? Promise.resolve()).catch(() => undefined).then(() => fetchAndCachePRs());
		return { success: true };
	},
	REFRESH_PRS: async () => {
		try {
			await fetchAndCachePRs(true);
			return { success: true };
		} catch (error) {
			if (isAuthError(error)) {
				return { success: false, error: 'TOKEN_INVALID' };
			}
			return { success: false, error: (error as Error)?.message || 'Failed to refresh PRs' };
		}
	},
	GET_PRS: async () => storage.getPullRequests(),
	// The page that changed a setting has already written it. This says which keys moved so the worker
	// can react — it is not a second write, which is what the old UPDATE_SETTINGS/SETTINGS_UPDATED pair
	// ended up doing to the same value.
	SETTINGS_CHANGED: async (message) => {
		if ('settings' in message) {
			if ('pollingIntervalMs' in message.settings) {
				await setupPollingAlarm(true);
			}

			if ('pinnedTab' in message.settings || 'badgeCountMode' in message.settings) {
				await refreshBadge();
			}
		}
		return { success: true };
	},
	CLEAR_ALL: async () => {
		await alarmsClear(ALARM_NAME);
		await actionSetBadgeText({ text: '' });
		return { success: true };
	},
};

// Test hatch. Paste `prPulseNotify()` into the service worker console to fire one through the real
// path — permission, icon, buttons and the click-to-open id are all exercised. The diff rules that
// decide *when* to fire are covered by pr-notify.test.ts instead; this only proves the plumbing.
Object.assign(globalThis, {
	prPulseNotify: (title = 'PR Pulse', message = 'Notifications are working') =>
		notificationsCreate(`test|${DASHBOARD_URL}`, { title, message, action: 'Open PR Pulse' }),
});

async function handleMessage(message: RuntimeMessage): Promise<unknown> {
	const handler = messageHandlers[message.type];
	if (handler) {
		return handler(message);
	}

	console.warn('Unknown message type:', message.type);
	return { error: 'Unknown message type' };
}
