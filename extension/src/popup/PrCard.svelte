<script lang="ts">
	import {
		Check,
		Copy,
		ExternalLink,
		FileDiff,
		FolderGit2,
		GitBranch,
		Ticket,
		Clock,
	} from 'lucide-svelte';
	import SectionCard from '../lib/components/SectionCard.svelte';
	import {
		isValidHttpUrl,
		formatLocalDateTime,
		formatPrAge,
	} from '../../lib/utils';
	import { jiraLinkFor } from '../../lib/jira';
	import { hasMergeConflicts } from '../../lib/pr-view';
	import type { PullRequest, Settings } from '../../lib/types';

	// `tone` and `dot` are the CSS classes this card applies directly, so the maps live beside it.
	interface StatusDisplay {
		label: string;
		tone: string;
		dot: string;
	}

	function getReviewStatusDisplay(status: string, openThreadCount?: number): StatusDisplay {
		switch (status) {
			case 'approved':
				return { label: 'Approved', tone: 'status-inline-success', dot: 'status-dot-success' };
			case 'changes_requested':
				return {
					label: openThreadCount && openThreadCount > 0 ? `Changes Requested (${openThreadCount})` : 'Changes Requested',
					tone: 'status-inline-danger',
					dot: 'status-dot-danger',
				};
			case 'pending':
			default:
				return { label: 'Review Pending', tone: 'status-inline-warning', dot: 'status-dot-warning' };
		}
	}

	function getCheckStatusDisplay(status: string): StatusDisplay {
		switch (status) {
			case 'success':
				return { label: 'Checks Passing', tone: 'status-inline-success', dot: 'status-dot-success' };
			case 'failure':
				return { label: 'Checks Failing', tone: 'status-inline-danger', dot: 'status-dot-danger' };
			case 'pending':
				return { label: 'Checks Running', tone: 'status-inline-warning', dot: 'status-dot-warning' };
			case 'unknown':
			default:
				return { label: 'No Checks', tone: 'status-inline-neutral', dot: 'status-dot-neutral' };
		}
	}

	type PullRequestCardSettings = Pick<Settings, 'jiraBaseUrl'>;

	interface Props {
		pr: PullRequest;
		isFullpageMode?: boolean;
		settings?: PullRequestCardSettings;
		copiedItemId?: string | null;
		onOpenUrl?: (url: string) => void;
		onCopy?: (value: string, id: string) => void;
	}

	let {
		pr,
		isFullpageMode = false,
		settings = { jiraBaseUrl: '' },
		copiedItemId = null,
		onOpenUrl = () => {},
		onCopy = () => {}
	}: Props = $props();

	function getBranchUrl(pr: PullRequest) {
		if (!pr?.repoFullName || !pr?.branchName) {
			return null;
		}

		return `https://github.com/${pr.repoFullName}/tree/${encodeURIComponent(pr.branchName).replaceAll('%2F', '/')}`;
	}

	function getJiraLink(pr: PullRequest) {
		const link = jiraLinkFor(pr.branchName, settings.jiraBaseUrl);
		return link && isValidHttpUrl(link.url) ? link : null;
	}

	// Conflicts replace the yellow/red review state on the card.
	const hasConflicts = hasMergeConflicts;

	function getCardStatusClass(pr: PullRequest) {
		if (pr.isDraft) {
			return 'pr-card-draft';
		}

		const checksStatus = pr.checks?.status;
		const reviewsStatus = pr.reviews?.status;

		if (checksStatus === 'failure' || reviewsStatus === 'changes_requested' || hasConflicts(pr)) {
			return 'pr-card-danger';
		}

		if (checksStatus === 'pending' || reviewsStatus === 'pending') {
			return 'pr-card-warning';
		}

		const checksOk = !checksStatus || checksStatus === 'success' || checksStatus === 'unknown';
		const reviewOk = reviewsStatus === 'approved';

		if (checksOk && reviewOk) {
			return 'pr-card-success';
		}

		return 'pr-card-warning';
	}

	let reviewDisplay = $derived(
		hasConflicts(pr)
			? { label: 'Merge Conflicts', tone: 'status-inline-danger', dot: 'status-dot-danger' }
			: getReviewStatusDisplay(pr.reviews?.status, pr.reviews?.openThreadCount)
	);
	let checkDisplay = $derived(getCheckStatusDisplay(pr.checks?.status));
	let jiraLink = $derived(getJiraLink(pr));
	let branchUrl = $derived(getBranchUrl(pr));
	let createdAtText = $derived(formatLocalDateTime(pr.createdAt));
	let statusRowClasses = $derived(isFullpageMode
		? 'flex flex-wrap gap-x-5 gap-y-1.5 text-xs'
		: 'flex min-w-0 items-center gap-2.5 text-xs');
	let checkStatusClasses = $derived(isFullpageMode
		? 'unstyled-button status-inline group'
		: 'unstyled-button status-inline min-w-0 group');
	let reviewUrl = $derived(
		pr.reviews?.status === 'changes_requested' && !hasConflicts(pr)
			? (pr.reviews?.firstUnresolvedThreadUrl
				?? (pr.reviews?.changesRequestedReviewId
					? `${pr.url}#pullrequestreview-${pr.reviews.changesRequestedReviewId}`
					: `${pr.url}/files`))
			: pr.url
	);
</script>

<SectionCard className={`p-3.5 transition-opacity pr-card-status ${getCardStatusClass(pr)} ${pr.isDraft ? 'opacity-80' : ''}`}>
	<div class="min-w-0 space-y-1.5">
		<div class="relative min-w-0 pr-6">
			<div class="flex min-w-0 items-start gap-1.5">
				<button class="unstyled-button pr-title-link group flex min-w-0 flex-1 items-start gap-2.5 text-left text-white" onclick={() => onOpenUrl(pr.url)} data-guide-id="title">
					<img src={pr.author?.avatarUrl || '../icons/icon128.png'} alt={pr.author?.name || pr.author?.login} title={pr.author?.name || pr.author?.login} class="mt-0.5 h-5 w-5 rounded-full object-cover shrink-0" />
					<span class={`line-clamp-2 min-w-0 wrap-break-word group-hover:underline group-hover:text-(--accent) group-hover:decoration-(--accent) decoration-[0.14em] ${pr.isDraft ? 'text-soft/90' : ''}`}>
						{pr.title}
					</span>
				</button>
				{#if pr.isDraft}
					<span class="mt-0.5 inline-flex shrink-0 items-center rounded border border-soft/20 bg-soft/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-soft leading-none">Draft</span>
				{/if}
			</div>
			<button class="unstyled-button metadata-copy-button absolute right-0 top-0" type="button" onclick={() => onCopy(pr.url, `pr-${pr.id}`)} aria-label="Copy PR link" title="Copy PR link" data-guide-id="copyPR">
				{#if copiedItemId === `pr-${pr.id}`}
					<Check class="metadata-copy-icon text-(--success)" />
				{:else}
					<Copy class="metadata-copy-icon" />
				{/if}
			</button>
		</div>

		<div class="meta-row">
			<button class="unstyled-button action-chip" onclick={() => onOpenUrl(`https://github.com/${encodeURI(pr.repoFullName || '')}`)} data-guide-id="repo">
				<FolderGit2 class="metadata-repo-icon" />
				<span class="hyperlink-text metadata-repo">{pr.repoFullName}</span>
			</button>
			<span aria-hidden="true" class="text-dim">•</span>
			<button class="unstyled-button action-chip" onclick={() => onOpenUrl(`${pr.url}/changes`)} data-guide-id="diff">
				<FileDiff class="metadata-diff-icon" />
				<span class="metadata-diff">
					<span class="metadata-diff-add">+{pr.changes?.additions ?? 0}</span>
					<span class="metadata-diff-del">-{pr.changes?.deletions ?? 0}</span>
				</span>
			</button>
		</div>

		{#if jiraLink || branchUrl}
			<div class="meta-row">
				{#if jiraLink}
				<button class="unstyled-button action-chip" onclick={() => onOpenUrl(jiraLink.url)} data-guide-id="jira">
					<Ticket class="metadata-jira-icon" />
					<span class="hyperlink-text metadata-jira">{jiraLink.ticket}</span>
				</button>
				{/if}
				{#if jiraLink && branchUrl}
					<span aria-hidden="true" class="text-dim">•</span>
				{/if}
				{#if branchUrl}
				<div class="flex items-center gap-0.5">
					<button class="unstyled-button action-chip" onclick={() => onOpenUrl(branchUrl)} data-guide-id="branch">
						<GitBranch class="metadata-branch-icon" />
						<span class="hyperlink-text metadata-branch">{pr.branchName}</span>
					</button>
					<button class="unstyled-button metadata-copy-button" type="button" onclick={() => onCopy(pr.branchName, `branch-${pr.id}`)} aria-label="Copy branch name" title="Copy branch name" data-guide-id="copyBranch">
						{#if copiedItemId === `branch-${pr.id}`}
							<Check class="metadata-copy-icon text-(--success)" />
						{:else}
							<Copy class="metadata-copy-icon" />
						{/if}
					</button>
				</div>
				{/if}
			</div>
		{/if}

		<div class="border-t border-soft pt-2.5">
			<div class={statusRowClasses}>
				<button
					class={`${checkStatusClasses} ${checkDisplay.tone}`}
					onclick={() => onOpenUrl(`${pr.url}/checks`)}
					data-guide-id="statusChecks"
				>
					<span class={`status-dot ${checkDisplay.dot}`}></span>
					<span class="status-inline-label">{checkDisplay.label}</span>
					<ExternalLink class="status-link-icon" />
				</button>
				<button
					class={`unstyled-button status-inline min-w-0 group ${reviewDisplay.tone}`}
					onclick={() => onOpenUrl(reviewUrl)}
					data-guide-id="statusReview"
				>
					<span class={`status-dot ${reviewDisplay.dot}`}></span>
					<span class="status-inline-label">{reviewDisplay.label}</span>
					<ExternalLink class="status-link-icon" />
				</button>
				{#if pr.behindBy && pr.behindBy > 0}
					<span class="shrink-0 whitespace-nowrap text-[11px] font-medium text-dim" title={`${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} on the base branch not yet in this branch`}>
						{pr.behindBy} behind
					</span>
				{/if}
				<div class="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-dim" title={createdAtText}>
					<Clock class="h-3 w-3" />
					<span>{formatPrAge(pr.createdAt)}</span>
				</div>
			</div>
		</div>
	</div>
</SectionCard>
