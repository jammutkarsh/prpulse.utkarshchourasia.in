<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft, CheckCircle2, ChevronDown, Clock3, Eraser, Expand, GitPullRequest, Inbox, ListFilter, MonitorCog, MonitorSmartphone, Pin, Save, ShieldAlert, Ticket, UserRound, Sparkles, Copy, Check, Bell, BellOff, List, Layers } from 'lucide-svelte';
	import Button from '../lib/components/Button.svelte';
	import RadioCard from '../lib/components/RadioCard.svelte';
	import SectionCard from '../lib/components/SectionCard.svelte';
	import InteractiveGuide from '../lib/components/InteractiveGuide.svelte';
	import AttributionFooter from '../lib/components/AttributionFooter.svelte';
	import NotificationTest from '../lib/components/NotificationTest.svelte';
	import { permissionsRequest, runtimeGetURL, runtimeSendMessage } from '../../lib/extension-api';
	import { storage } from '../../lib/storage';
	import type { Settings, StoredProviderConfig } from '../../lib/types';
	import { isValidHttpUrl, copyToClipboard } from '../../lib/utils';
	import { jiraDashboardUrlFor, sanitizeJiraUrl } from '../../lib/jira';
	import { commitProvider, connectGithubToken, refreshTokenExpiration } from '../../lib/github-connect';
	import { DEFAULT_SETTINGS } from '../../lib/ui-config';

	const pollingOptions = [
		{ value: 0, label: 'Manual' },
		{ value: 60000, label: '1 minute' },
		{ value: 300000, label: '5 minutes' },
		{ value: 600000, label: '10 minutes' },
		{ value: 900000, label: '15 minutes' },
		{ value: 1800000, label: '30 minutes' },
		{ value: 3600000, label: '60 minutes' },
		{ value: -1, label: 'Custom' },
	];

	const PRESET_POLLING_VALUES = new Set([0, 60000, 300000, 600000, 900000, 1800000, 3600000]);

	let provider = $state<StoredProviderConfig | undefined>(undefined);
	let currentSettings = $state<Settings>(DEFAULT_SETTINGS);
	let jiraUrl = $state('');
	let pollingIntervalMs = $state(600000);
	let selectedPollingValue = $state(600000);
	let customMinutes = $state(10);
	let token = $state('');
	let tokenError = $state('');
	let tokenSuccess = $state('');
	let reconnecting = $state(false);
	let validatingToken = $state(false);
	let saveVisible = $state(false);
	let saveTimeoutId: ReturnType<typeof setTimeout> | undefined;
	let isTokenInvalid = $state(false);

	let revealConfirmState = $state(false);
	let revealedToken = $state('');
	let copySuccess = $state(false);

	async function handleCopyToken() {
		if (revealedToken) {
			await copyToClipboard(revealedToken);
			copySuccess = true;
			setTimeout(() => { 
				copySuccess = false; 
				revealedToken = '';
			}, 1200);
		}
	}

	let isConnected = $derived(!!(provider && provider.user && !reconnecting));
	let jiraDashboardUrl = $derived(jiraUrl && isValidHttpUrl(jiraUrl) ? jiraDashboardUrlFor(jiraUrl) : '');
	let normalizedCustomMinutes = $derived.by(() => {
		const parsed = Number(customMinutes);
		if (!Number.isFinite(parsed)) {
			return null;
		}

		return Math.min(1440, Math.max(1, Math.floor(parsed)));
	});
	let hasPendingCustomInterval = $derived(
		selectedPollingValue === -1 &&
		normalizedCustomMinutes !== null &&
		normalizedCustomMinutes * 60000 !== pollingIntervalMs
	);

	function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && provider && provider.user) {
			void fetchTokenExpiration();
		}
	}

	onMount(() => {
		document.addEventListener('visibilitychange', handleVisibilityChange);
		void init();
		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	async function init() {
		const [nextSettings, nextProvider] = await Promise.all([storage.getSettings(), storage.getProvider()]);
		currentSettings = nextSettings;
		provider = nextProvider;
		isTokenInvalid = provider?.isTokenInvalid ?? false;
		jiraUrl = sanitizeJiraUrl(currentSettings.jiraBaseUrl || '');
		pollingIntervalMs = currentSettings.pollingIntervalMs ?? 600000;
		if (PRESET_POLLING_VALUES.has(pollingIntervalMs)) {
			selectedPollingValue = pollingIntervalMs;
		} else {
			selectedPollingValue = -1;
			customMinutes = Math.round(pollingIntervalMs / 60000);
		}

		void fetchTokenExpiration();
	}

	async function fetchTokenExpiration() {
		if (!provider || !provider.user) return;

		const { status, provider: refreshed } = await refreshTokenExpiration(provider);
		provider = refreshed;

		// `unreachable` leaves the flag as the worker last set it — only GitHub's own 401 clears or sets it.
		if (status === 'unreachable') return;

		isTokenInvalid = status === 'invalid';
		if (isTokenInvalid) {
			reconnecting = true;
		}
	}

	function handleRevealClick() {
		if (!revealConfirmState) {
			revealConfirmState = true;
			setTimeout(() => {
				if (!revealedToken) revealConfirmState = false;
			}, 3000);
		} else {
			revealedToken = provider?.token || '';
			revealConfirmState = false;
		}
	}

	function flashSaved() {
		saveVisible = true;
		clearTimeout(saveTimeoutId);
		saveTimeoutId = setTimeout(() => {
			saveVisible = false;
		}, 2000);
	}

	async function updateSetting<K extends keyof Settings>(name: K, value: Settings[K]) {
		currentSettings = { ...currentSettings, [name]: value };
		await storage.setSettings({ [name]: value } as Partial<Settings>);
		flashSaved();
	}

	async function updatePinnedTab(value: Settings['pinnedTab']) {
		await updateSetting('pinnedTab', value);
		await runtimeSendMessage({ type: 'SETTINGS_CHANGED', settings: { pinnedTab: value } });
	}

	// Turning them on has to clear the browser's optional-permission prompt first; a decline leaves the
	// setting off rather than promising notifications that cannot fire.
	async function updateNotifications(enabled: boolean) {
		await updateSetting('notificationsEnabled', enabled && (await permissionsRequest(['notifications'])));
	}

	async function updateDisplayMode(value: Settings['displayMode']) {
		await updateSetting('displayMode', value);
	}

	async function updatePollingInterval(event: Event) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) {
			return;
		}

		const value = Number.parseInt(target.value, 10);
		if (!Number.isFinite(value)) {
			return;
		}

		if (value === -1) {
			customMinutes = Math.max(1, Math.round(pollingIntervalMs / 60000));
			return;
		}

		pollingIntervalMs = value;
		await updateSetting('pollingIntervalMs', value);
		await runtimeSendMessage({ type: 'SETTINGS_CHANGED', settings: { pollingIntervalMs: value } });
	}

	async function applyCustomInterval() {
		if (normalizedCustomMinutes === null) {
			return;
		}

		const mins = normalizedCustomMinutes;
		customMinutes = mins;
		const ms = mins * 60000;

		if (ms === pollingIntervalMs) {
			return;
		}

		pollingIntervalMs = ms;
		await updateSetting('pollingIntervalMs', ms);
		await runtimeSendMessage({ type: 'SETTINGS_CHANGED', settings: { pollingIntervalMs: ms } });
	}

	async function saveJiraUrl() {
		const sanitized = sanitizeJiraUrl(jiraUrl.trim());
		jiraUrl = sanitized;
		await updateSetting('jiraBaseUrl', sanitized);
	}

	async function validateAndSaveToken() {
		tokenError = '';
		tokenSuccess = '';
		validatingToken = true;

		try {
			const result = await connectGithubToken(token);
			if (result.status === 'rejected') {
				tokenError = result.error;
				return;
			}

			provider = await commitProvider(result.provider);
			tokenSuccess = `Connected as ${provider.user?.name || provider.user?.login}`;
			reconnecting = false;
			isTokenInvalid = false;
			token = '';
			flashSaved();
		} finally {
			validatingToken = false;
		}
	}

	function goBack() {
		window.location.href = runtimeGetURL('popup/popup.html?fullpage=1');
	}

	async function resetAll() {
		if (!confirm('This will clear all settings and cached data. Continue?')) {
			return;
		}

		await storage.clearAll();
		await runtimeSendMessage({ type: 'CLEAR_ALL' });
		window.location.href = runtimeGetURL('onboarding/onboarding.html');
	}
</script>

<div class="page-screen">
	<div class="page-wrap">
		<div class="flex items-center justify-between gap-3">
			<Button variant="ghost" onclick={goBack}>
				<ArrowLeft class="h-4 w-4" />
				Back to PR Pulse
			</Button>
			{#if saveVisible}
				<div class="accent-surface flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium text-(--accent)">
					<CheckCircle2 class="h-3.5 w-3.5" />
					Settings saved
				</div>
			{/if}
		</div>

		<div class="surface-card-padded">
			<div class="max-w-xl space-y-2">
				<div class="section-title">Settings</div>
			</div>
		</div>

		<SectionCard>
			<div class="section-row">
				<div class="accent-box">
					<UserRound class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">GitHub Account</h2>
					<p class="desc">Manage the token used by the background sync and popup.</p>
				</div>
			</div>

			{#if isConnected}
				<div class="rounded-[20px] border border-soft bg-black/20 p-4">
					<div class="flex items-center justify-between gap-4">
						<div class="flex items-center gap-3">
							<img src={provider.user.avatarUrl} alt="Avatar" class="h-11 w-11 rounded-2xl border border-soft object-cover shrink-0" />
							<div class="min-w-0">
								<div class="label-title truncate">{provider.user.name || provider.user.login}</div>
								<div class="label-sub truncate">@{provider.user.login}</div>
							</div>
						</div>
						<div class="text-right text-xs font-medium text-dim">
							{#if provider.user.tokenExpiration}
								Expires:<br/><span class="text-white/80">{new Date(provider.user.tokenExpiration).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
							{:else if provider.user.tokenExpiration === null}
								<span class="text-white/80">Never expires</span>
							{:else}
								Checking...
							{/if}
						</div>
					</div>

					<div class="mt-4 flex flex-wrap items-center justify-between gap-3 bg-black/20 p-2.5 px-3 rounded-xl border border-white/5">
						<div class="flex items-center gap-3 flex-1 min-w-0">
							<span class="text-xs font-medium text-dim shrink-0">Token</span>
							{#if revealedToken}
								<code class="font-mono text-xs text-white truncate">{revealedToken}</code>
							{:else}
								<code class="font-mono text-xs text-soft/40 truncate">•••••••••••••••••••••••••••••••••••••••••</code>
							{/if}
						</div>
						<div class="shrink-0 flex items-center gap-2">
							{#if revealedToken}
								<Button variant="ghost" onclick={handleCopyToken}>
									{#if copySuccess}
										<Check class="h-4 w-4 mr-1.5 text-(--success)" />
										Copied
									{:else}
										<Copy class="h-4 w-4 mr-1.5" />
										Copy
									{/if}
								</Button>
							{:else}
								<Button variant="ghost" onclick={handleRevealClick}>
									{#if revealConfirmState}
										Confirm?
									{:else}
										Reveal
									{/if}
								</Button>
							{/if}
						</div>
					</div>

					<div class="mt-4 flex">
						<Button variant="secondary" onclick={() => reconnecting = true}>Reconnect with a different token</Button>
					</div>
				</div>
			{:else}
				<div class="space-y-3">
					{#if isTokenInvalid}
						<div class="rounded-lg border border-(--danger)/20 bg-(--danger)/10 p-3 text-sm text-(--danger)">
							Your GitHub token has expired or was revoked. Please connect a new one.
						</div>
					{/if}
					<input class="field-input" type="password" bind:value={token} placeholder="ghp_xxxxxxxxxxxxx" autocomplete="off" />
					<p class="desc">Enter a GitHub personal access token with repository access. Need a token? <a class="link-accent" href="https://github.com/settings/tokens/new?scopes=repo&description=PR%20Pulse" target="_blank" rel="noopener noreferrer">Create one here</a>.</p>
					<div class="flex flex-wrap gap-3">
						<Button onclick={validateAndSaveToken} disabled={validatingToken}>
							{validatingToken ? 'Validating...' : 'Connect'}
						</Button>
						{#if provider?.user && !isTokenInvalid}
							<Button variant="secondary" onclick={() => reconnecting = false}>Cancel</Button>
						{/if}
					</div>
					{#if tokenError}
						<p class="text-sm text-(--danger)">{tokenError}</p>
					{/if}
					{#if tokenSuccess}
						<p class="text-sm text-(--accent)">{tokenSuccess}</p>
					{/if}
				</div>
			{/if}
		</SectionCard>

		<SectionCard>
			<div class="section-row">
				<div class="step-icon">
					<Pin class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">Default View</h2>
					<p class="desc">Choose the tab the popup opens to by default.</p>
				</div>
			</div>
			<div class="grid-2">
				<RadioCard name="pinnedTab" value="myPRs" currentValue={currentSettings.pinnedTab || 'myPRs'} title="My PRs" description="Track the pull requests you created." iconComponent={GitPullRequest} onchange={updatePinnedTab} />
				<RadioCard name="pinnedTab" value="toReview" currentValue={currentSettings.pinnedTab || 'myPRs'} title="To Review" description="Track the pull requests that need your attention as a reviewer." iconComponent={Inbox} onchange={updatePinnedTab} />
			</div>
		</SectionCard>

		<SectionCard>
			<div class="section-row">
				<div class="step-icon">
					<Ticket class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">Jira Integration</h2>
					<p class="desc">Jira origin link to derive ticket links from branch names.</p>
				</div>
			</div>
			<div class="space-y-3">
				<input class="field-input" type="url" bind:value={jiraUrl} placeholder="https://company.atlassian.net/browse/PROJ-123" onblur={saveJiraUrl} />
				{#if jiraDashboardUrl}
					<p class="desc">Your Dashboard: <a class="link-accent" href={jiraDashboardUrl} target="_blank" rel="noopener noreferrer">{jiraDashboardUrl}</a></p>
				{:else}
					<p class="desc">Enter any Jira URL and PR Pulse will normalize it to the base workspace URL.</p>
				{/if}
			</div>
		</SectionCard>

		<div class="grid gap-4 lg:grid-cols-2">
			<SectionCard>
				<div class="section-row">
					<div class="step-icon">
						<Clock3 class="h-5 w-5" />
					</div>
					<div>
						<h2 class="card-title">Refresh Interval</h2>
						<p class="desc">Control how often the background worker refreshes cached PR data.</p>
					</div>
				</div>
				<div class="space-y-3">
					<div class="relative">
						<select class="select-input pr-10" bind:value={selectedPollingValue} onchange={updatePollingInterval}>
							{#each pollingOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
						<div class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-soft">
							<ChevronDown class="h-4 w-4" />
						</div>
					</div>
					{#if selectedPollingValue === 0}
						<p class="desc">Pull requests will only update when you click the refresh button in the popup.</p>
					{:else if selectedPollingValue === -1}
						<div class="flex items-center gap-3">
							<input class="field-input" type="number" min="1" max="1440" bind:value={customMinutes} placeholder="Minutes (1–1440)" />
							{#if hasPendingCustomInterval}
								<Button onclick={applyCustomInterval}>Apply</Button>
							{/if}
						</div>
						<p class="desc">Enter a value between 1 and 1440 minutes (1 day max).</p>
					{/if}
				</div>
			</SectionCard>

			<SectionCard>
				<div class="section-row">
					<div class="step-icon">
						<MonitorCog class="h-5 w-5" />
					</div>
					<div>
						<h2 class="card-title">Display Mode</h2>
						<p class="desc">Choose view mode when extension is clicked.</p>
					</div>
				</div>
				<div class="grid gap-3">
					<RadioCard name="displayMode" value="popup" currentValue={currentSettings.displayMode || 'popup'} title="Popup" description="Keep the toolbar interaction lightweight and compact." iconComponent={MonitorSmartphone} onchange={updateDisplayMode} />
					<RadioCard name="displayMode" value="fullpage" currentValue={currentSettings.displayMode || 'popup'} title="Full Page" description="Use a larger tab surface for denser layouts" iconComponent={Expand} onchange={updateDisplayMode} />
				</div>
			</SectionCard>
		</div>

		<SectionCard>
			<div class="section-row">
				<div class="step-icon">
					<ListFilter class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">Filters</h2>
					<p class="desc">Configure the active filter persistence.</p>
				</div>
			</div>
			<div class="grid-2">
				<RadioCard name="persistFilters" value={true} currentValue={currentSettings.persistFilters ?? true} title="Remember Filters" description="Keep your active filters across extension sessions." iconComponent={Save} onchange={() => updateSetting('persistFilters', true)} />
				<RadioCard name="persistFilters" value={false} currentValue={currentSettings.persistFilters ?? true} title="Per Session" description="Clear active filters every time you close the popup." iconComponent={Eraser} onchange={() => updateSetting('persistFilters', false)} />
			</div>
		</SectionCard>

		<SectionCard>
			<div class="section-row">
				<div class="step-icon">
					<Bell class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">Notifications</h2>
					<p class="desc">Get told when a PR needs you, without watching the badge. Your filters do not apply.</p>
				</div>
			</div>
			<div class="grid-2">
				<RadioCard name="notificationsEnabled" value={true} currentValue={currentSettings.notificationsEnabled ?? ''} title="On" description="Review requests, review verdicts, CI failures and closed PRs." iconComponent={Bell} onchange={() => updateNotifications(true)} />
				<RadioCard name="notificationsEnabled" value={false} currentValue={currentSettings.notificationsEnabled ?? ''} title="Off" description="Stay quiet. The toolbar badge still updates." iconComponent={BellOff} onchange={() => updateNotifications(false)} />
			</div>
			{#if currentSettings.notificationsEnabled}
				<div class="grid-2 mt-3">
					<RadioCard name="groupNotifications" value={false} currentValue={currentSettings.groupNotifications} title="One per PR" description="A separate notification for every PR that changed." iconComponent={List} onchange={() => updateSetting('groupNotifications', false)} />
					<RadioCard name="groupNotifications" value={true} currentValue={currentSettings.groupNotifications} title="Grouped" description="Several changes of one kind in a refresh become a single count." iconComponent={Layers} onchange={() => updateSetting('groupNotifications', true)} />
				</div>
				<NotificationTest className="mt-3" />
			{/if}
		</SectionCard>

		<SectionCard>
			<div class="section-row">
				<div class="step-icon">
					<GitPullRequest class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">Badge Count</h2>
					<p class="desc">Choose what the icon badge number represents.</p>
				</div>
			</div>
			<div class="grid-2">
				<RadioCard name="badgeCountMode" value="total" currentValue={currentSettings.badgeCountMode ?? 'total'} title="Total PRs" description="Show the total number of pull requests in the pinned tab." iconComponent={GitPullRequest} onchange={async () => { await updateSetting('badgeCountMode', 'total'); await runtimeSendMessage({ type: 'SETTINGS_CHANGED', settings: { badgeCountMode: 'total' } }); }} />
				<RadioCard name="badgeCountMode" value="filters" currentValue={currentSettings.badgeCountMode ?? 'total'} title="Filtered PRs" description="Show the count matching your active filters and search." iconComponent={ListFilter} onchange={async () => { await updateSetting('badgeCountMode', 'filters'); await runtimeSendMessage({ type: 'SETTINGS_CHANGED', settings: { badgeCountMode: 'filters' } }); }} />
			</div>
		</SectionCard>

		<SectionCard>
			<div class="mb-0 flex items-center gap-3">
				<div class="step-icon">
					<Sparkles class="h-5 w-5" />
				</div>
				<div>
					<h2 class="card-title">Visual Guidance</h2>
					<p class="desc">Hover over the sample card elements to recall what they do.</p>
				</div>
			</div>
			<InteractiveGuide />
		</SectionCard>

		<SectionCard className="danger-surface">
			<div class="mb-4 flex items-center gap-3 text-(--danger)">
				<div class="danger-surface rounded-lg border p-3">
					<ShieldAlert class="h-5 w-5" />
				</div>
				<div>
					<h2 class="text-base font-semibold">Danger Zone</h2>
					<p class="text-sm text-[rgba(255,194,188,0.82)]">Clear cached data and reset the extension back to its first-run state.</p>
				</div>
			</div>
			<Button variant="danger" onclick={resetAll}>Reset all settings and data</Button>
		</SectionCard>

		<AttributionFooter />
	</div>
</div>
