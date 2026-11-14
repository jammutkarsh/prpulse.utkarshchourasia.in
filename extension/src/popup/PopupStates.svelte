<script lang="ts">
	import { Inbox, RefreshCw, UserRound } from 'lucide-svelte';
	import Button from '../lib/components/Button.svelte';
	import type { Settings } from '../../lib/types';

	interface Props {
		setupRequired?: boolean;
		errorMessage?: string;
		currentTab?: Settings['pinnedTab'];
		/** A fetch is running, so an empty list means "not here yet" rather than "none". */
		syncing?: boolean;
		onOpenSetup?: () => void;
		onRetry?: () => void;
	}

	let {
		setupRequired = false,
		errorMessage = '',
		currentTab = 'myPRs',
		syncing = false,
		onOpenSetup = () => {},
		onRetry = () => {}
	}: Props = $props();
</script>

{#if setupRequired}
	<div class="state-shell">
		<div class="accent-surface rounded-full p-4 text-(--accent)">
			<UserRound class="h-8 w-8" />
		</div>
		<div class="space-y-1">
			<h2 class="text-lg font-semibold">Setup Required</h2>
			<p class="max-w-sm desc">Connect your GitHub account to start tracking PRs in the popup.</p>
		</div>
		<Button onclick={onOpenSetup}>Open Setup</Button>
	</div>
{:else if errorMessage}
	<div class="state-shell">
		<div class="text-sm text-(--danger)">{errorMessage}</div>
		<Button variant="secondary" onclick={onRetry}>Try Again</Button>
	</div>
{:else if syncing}
	<div class="state-shell">
		<div class="rounded-full bg-white/6 p-4 text-soft">
			<RefreshCw class="h-8 w-8 animate-spin" />
		</div>
		<h2 class="text-lg font-semibold">Fetching pull requests</h2>
		<p class="max-w-sm desc">They will show up here as they arrive.</p>
	</div>
{:else}
	<div class="state-shell">
		<div class="rounded-full bg-white/6 p-4 text-soft">
			<Inbox class="h-8 w-8" />
		</div>
		<h2 class="text-lg font-semibold">No pull requests here</h2>
		<p class="max-w-sm desc">
			{currentTab === 'myPRs' ? "You don't have any open PRs right now." : 'No pull requests are waiting for your review.'}
		</p>
	</div>
{/if}
