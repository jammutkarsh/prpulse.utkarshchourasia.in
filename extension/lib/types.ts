export type ProviderType = 'github';

export interface User {
	login: string;
	avatarUrl: string;
	name: string;
	tokenExpiration?: string | null;
}

export interface PullRequestAuthor {
	login: string;
	avatarUrl: string;
	name: string;
}

export interface PullRequestRepoOwner {
	login: string;
	type: 'org' | 'user' | 'unknown';
}

export interface PullRequestChanges {
	additions: number;
	deletions: number;
	filesChanged: number;
}

export interface PullRequestChecks {
	status: 'success' | 'failure' | 'pending' | 'unknown';
}

export interface PullRequestReviewer {
	login: string;
	avatarUrl: string;
	state: string;
}

export interface PullRequestReviews {
	status: 'approved' | 'changes_requested' | 'pending';
	reviewers: PullRequestReviewer[];
	pendingReviewers?: string[];
	openThreadCount?: number;
	changesRequestedReviewId?: number;
	firstUnresolvedThreadUrl?: string;
}

export interface PullRequest {
	id: string;
	provider: ProviderType;
	number: number;
	title: string;
	url: string;
	repoFullName: string;
	repoOwner: PullRequestRepoOwner;
	branchName: string;
	author: PullRequestAuthor;
	state: string;
	changes: PullRequestChanges;
	checks: PullRequestChecks;
	reviews: PullRequestReviews;
	createdAt: string;
	updatedAt: string;
	isDraft: boolean;
	/** GitHub computes this lazily, so `unknown` is normal right after a base-branch push. Absent when the source can't tell. */
	mergeable?: 'mergeable' | 'conflicting' | 'unknown';
}

/** What every pull-request source hands back, whatever it reads from. */
export interface PrSourceResult {
	myPRs: PullRequest[];
	reviewRequests: PullRequest[];
}

/** How far a fetch has got. `total` is the sources' own estimate and can be off by PRs that change mid-fetch. */
export interface SyncProgress {
	loaded: number;
	total: number;
}

/** Called after every page with everything fetched so far, so a slow first sync can be shown as it lands. */
export type SyncProgressListener = (partial: PrSourceResult, progress: SyncProgress) => void;

/** The worker's fetch, as the popup sees it. Kept in storage because the worker and the popup share nothing else. */
export interface SyncStatus extends SyncProgress {
	inProgress: boolean;
	startedAt: number;
	/** Refreshed by the worker while it runs, so a slow but live sync is not mistaken for an abandoned one. */
	updatedAt?: number;
}

/** The seam: fetching pull requests. Token identity is a separate concern and deliberately absent. */
export interface PrSource {
	getAllPullRequests(onProgress?: SyncProgressListener): Promise<PrSourceResult>;
	/** Current `PullRequest['state']` by id, for PRs that dropped out of the open list. Optional: only the extension notifies. */
	getStates?(ids: string[]): Promise<Map<string, string>>;
}

export interface ProviderConfig {
	token?: string;
	baseUrl?: string;
}

export interface StoredProviderConfig extends ProviderConfig {
	type: ProviderType;
	user?: User;
	isTokenInvalid?: boolean;
}

export interface UiConfig {
	pageMaxWidthRem: number;
	popupWidthRem: number;
	popupHeightRem: number;
	popupInsetRem: number;
	surfaceRadiusPx: number;
	sectionRadiusPx: number;
	fieldRadiusPx: number;
	smoothScroll: boolean;
}

export interface Settings {
	jiraBaseUrl: string;
	displayMode: 'popup' | 'fullpage';
	pinnedTab: 'myPRs' | 'toReview';
	visibleColumns: string[];
	pollingIntervalMs: number;
	persistFilters: boolean;
	badgeCountMode: 'total' | 'filters';
	/** `null` means never asked. The popup prompts on that, and stores the answer either way so it asks once. */
	notificationsEnabled: boolean | null;
	/** Collapse several changes of one kind in a single refresh into one count, instead of one per PR. */
	groupNotifications: boolean;
	ui: UiConfig;
}

export interface PullRequestData {
	myPRs: PullRequest[];
	reviewRequests: PullRequest[];
	lastFetched: number | null;
}

export type PopupTab = Settings['pinnedTab'];

export type FiltersByTab = Record<PopupTab, PopupFilters>;

export interface PopupFilters {
	authors: string[];
	owners: string[];
	repos: string[];
	ageRange: string;
	drafts: 'only' | 'include' | 'exclude';
	showReviewed: boolean;
}

export type StoredFilters = Partial<PopupFilters>;

export interface StoredFilterState {
	tabs?: Partial<Record<PopupTab, StoredFilters>>;
	/** Pre-per-tab shape, still on disk for anyone who has not opened the popup since. */
	activeFilters?: StoredFilters;
}

export interface PopupAuthorFilterOption {
	login: string;
	name: string;
}

export interface PopupOwnerFilterOption {
	login: string;
	type: PullRequestRepoOwner['type'];
}

export interface PopupRepoFilterOption {
	fullName: string;
	owner: string;
	ownerType: PullRequestRepoOwner['type'];
	name: string;
}

export type RuntimeMessage =
	| { type: 'PROVIDER_CONFIGURED' }
	| { type: 'REFRESH_PRS' }
	| { type: 'GET_PRS' }
	/** Storage is already written by the sender; this only tells the worker which keys moved. */
	| { type: 'SETTINGS_CHANGED'; settings: Partial<Settings> }
	| { type: 'CLEAR_ALL' };

export interface ProviderErrorDetails {
	statusCode?: number;
	retryable?: boolean;
	provider?: string;
}
