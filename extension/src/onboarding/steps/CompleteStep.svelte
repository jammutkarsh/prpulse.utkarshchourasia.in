<script lang="ts">
	import { CheckCircle2, RefreshCw } from 'lucide-svelte';
	import Button from '../../lib/components/Button.svelte';
	import SectionCard from '../../lib/components/SectionCard.svelte';
	import InteractiveGuide from '../../lib/components/InteractiveGuide.svelte';
	import type { Settings } from '../../../lib/types';

	interface Props {
		displayMode?: Settings['displayMode'];
		syncedPrCount?: number;
		/** The first sync is still running, so the count is a running total. */
		syncing?: boolean;
		onClose?: () => void;
	}

	let { displayMode = 'popup', syncedPrCount = 0, syncing = false, onClose = () => {} }: Props = $props();
</script>

<SectionCard className="p-6">
	<div class="flex flex-col items-center gap-5 text-center">
		<div class="accent-surface rounded-full border p-4 text-(--accent)">
			<CheckCircle2 class="h-10 w-10" />
		</div>
		<div class="space-y-2">
			<h2 class="text-2xl font-semibold text-white">Get familiar with PR Pulse</h2>
			<p class="desc">Hover over the elements in the sample card below to see how it works.</p>
			{#if syncing || syncedPrCount > 0}
				<div class="inline-flex items-center gap-1.5 rounded-full border border-(--accent-border) bg-(--accent-muted) px-3 py-1 text-xs font-medium text-(--accent)">
					{#if syncing}
						<RefreshCw class="h-3 w-3 animate-spin" />
						<span>Syncing… {syncedPrCount} PR{syncedPrCount !== 1 ? 's' : ''} so far</span>
					{:else}
						<span>Synced {syncedPrCount} PR{syncedPrCount !== 1 ? 's' : ''}</span>
					{/if}
				</div>
			{/if}
		</div>
		<div class="space-y-4">
			<InteractiveGuide />
		</div>
		{#if displayMode === 'popup'}
			<div class="flex flex-col items-center gap-2 mt-4">
				<Button onclick={onClose}>Close Setup</Button>
				<span class="desc">Pin the extension and click on it to open.</span>
			</div>
		{:else}
			<div class="mt-4">
				<Button onclick={onClose}>Open PR Pulse</Button>
			</div>
		{/if}
	</div>
</SectionCard>
