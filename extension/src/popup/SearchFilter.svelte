<script lang="ts">
    import { tick } from 'svelte';
    import { onDestroy, onMount } from 'svelte';
    import { ChevronDown, ChevronRight, ListFilter, Search, Trash2, X } from 'lucide-svelte';
    import type { PullRequestRepoOwner, PopupFilters } from '../../lib/types';
    import { countActiveFilters, createDefaultFilters, type PrViewOptions } from '../../lib/pr-view';
    import Button from '../lib/components/Button.svelte';

    type FilterChip = {
        key: string;
        label: string;
        value: string;
        onRemove: () => void;
    };

    /** A checkbox row, with the per-axis differences already resolved into plain strings. */
    type FilterRow = {
        id: string;
        primary: string;
        primaryTitle?: string;
        secondary: string;
        secondaryClass: string;
    };

    type CheckboxAxis = 'authors' | 'owners' | 'repos';

    type FilterSectionView = {
        key: CheckboxAxis;
        title: string;
        placeholder: string;
        show: boolean;
        /** Driven by the option count before the section's own search narrows it. */
        showSearch: boolean;
        singleLabel: string;
        availableSet: Set<string>;
        rows: FilterRow[];
    };

    const TYPE_LABEL_CLASS = 'type-label';
    const AUTHOR_NAME_CLASS = 'shrink-0 truncate text-[11px] text-soft';

    const LAYOUT = {
        compact: {
            outerPad: 'px-2.5 py-1.5',
            panelPad: 'px-2 py-1.5',
            sectionSpace: 'space-y-1',
            headerPad: 'px-2 py-1 text-[13px]',
            contentPad: 'px-2 py-1',
            labelPad: 'px-1.5 py-0.5 text-[13px] gap-2',
            rowGap: 'gap-1',
            sectionGap: 'gap-0.5',
            filterPanelMaxHeight: '12rem',
            visibleLimit: 3,
            overflowListClass: 'max-h-[8.25rem] space-y-1 overflow-y-auto pr-1 scroll-thin',
        },
        full: {
            outerPad: 'px-4 py-3',
            panelPad: 'px-4 py-3',
            sectionSpace: 'space-y-2',
            headerPad: 'px-3 py-2 text-sm',
            contentPad: 'px-3 py-2',
            labelPad: 'px-2 py-1.5 text-sm gap-3',
            rowGap: 'gap-2',
            sectionGap: 'gap-1',
            filterPanelMaxHeight: 'min(40rem, calc(100vh - 13rem))',
            visibleLimit: 4,
            overflowListClass: 'max-h-[11rem] space-y-1 overflow-y-auto pr-1 scroll-thin',
        },
    } as const;

    interface Props {
        query?: string;
        activeFilters?: PopupFilters;
        /** The view's option lists, whole. Callers used to take this apart into nine props each. */
        options: PrViewOptions;
        isToReviewTab?: boolean;
        isSearchOpen?: boolean;
        isFilterOpen?: boolean;
        embedded?: boolean;
        fullpageMode?: boolean;
    }

    let {
        query = $bindable(''),
        activeFilters = $bindable(createDefaultFilters()),
        options,
        isToReviewTab = false,
        isSearchOpen = $bindable(false),
        isFilterOpen = $bindable(false),
        embedded = false,
        fullpageMode = false,
    }: Props = $props();

    // Unpacked here rather than by every caller: `has*Filter` is a property of the option list,
    // not something a parent should work out and pass back in.
    let allAuthors = $derived(options.authors.all);
    let allOwners = $derived(options.owners.all);
    let allRepos = $derived(options.repos.all);
    let availableAuthors = $derived(options.authors.available);
    let availableOwners = $derived(options.owners.available);
    let availableRepos = $derived(options.repos.available);
    let hasAuthorFilter = $derived(allAuthors.length > 1);
    let hasOwnerFilter = $derived(allOwners.length > 1);
    let hasRepoFilter = $derived(allRepos.length > 1);

    let expandedSections = $state({
        authors: false,
        owners: false,
        repos: false,
        drafts: false,
        reviewStatus: false,
        conflicts: false,
    });

    let searchInput = $state<HTMLInputElement | null>(null);
    let sectionSearch = $state({ authors: '', owners: '', repos: '' });
    let surfaceElement = $state<HTMLDivElement | null>(null);
    let ignoreOutsideClick = false;
    let wasSearchOpen = false;
    let wasFilterOpen = false;
    let openGuardTimeout: ReturnType<typeof setTimeout> | null = null;

    onMount(() => {
        function handleClick(event: MouseEvent) {
            if (!isSearchOpen || !surfaceElement || ignoreOutsideClick) {
                return;
            }

            const clickPath = event.composedPath();
            if (!clickPath.includes(surfaceElement)) {
                closeSearchSurface();
            }
        }

        window.addEventListener('click', handleClick);

        return () => {
            window.removeEventListener('click', handleClick);
        };
    });

    onDestroy(() => {
        clearOutsideClickGuard();
    });

    function syncSearchSurfaceState(searchOpen: boolean) {
        if (searchOpen === wasSearchOpen) {
            return;
        }

        wasSearchOpen = searchOpen;

        if (searchOpen) {
            armOutsideClickGuard();
            return;
        }

        clearOutsideClickGuard();
    }

    function armOutsideClickGuard() {
        ignoreOutsideClick = true;
        tick().then(() => searchInput?.focus());

        if (openGuardTimeout !== null) {
            clearTimeout(openGuardTimeout);
        }

        openGuardTimeout = setTimeout(() => {
            ignoreOutsideClick = false;
            openGuardTimeout = null;
        }, 0);
    }

    function clearOutsideClickGuard() {
        if (openGuardTimeout !== null) {
            clearTimeout(openGuardTimeout);
            openGuardTimeout = null;
        }

        ignoreOutsideClick = false;
    }

    function toggleFilterPanel() {
        isFilterOpen = !isFilterOpen;
    }

    function toggleSection(section: keyof typeof expandedSections) {
        expandedSections = {
            ...expandedSections,
            [section]: !expandedSections[section],
        };
    }

    function toggleFilter<K extends 'authors' | 'owners' | 'repos'>(key: K, value: string) {
        const list = activeFilters[key] as string[];
        const updated = list.includes(value)
            ? list.filter((entry) => entry !== value)
            : [...list, value];
        activeFilters = { ...activeFilters, [key]: updated };
    }

    function clearAxis(key: CheckboxAxis) {
        activeFilters = { ...activeFilters, [key]: [] };
    }

    function clearSearch() {
        query = '';
    }

    function clearAllFilters() {
        query = '';
        activeFilters = createDefaultFilters();
    }

    function closeSearchSurface() {
        clearOutsideClickGuard();
        isSearchOpen = false;
        isFilterOpen = false;
    }

    function matchesFilterQuery(value: string, filterQuery: string, alternateValue = '') {
        const normalizedQuery = filterQuery.trim().toLowerCase();

        if (!normalizedQuery) {
            return true;
        }

        return value.toLowerCase().includes(normalizedQuery) || alternateValue.toLowerCase().includes(normalizedQuery);
    }

    function getSectionListClass(optionCount: number) {
        return optionCount <= layout.visibleLimit
            ? 'space-y-1 pr-1'
            : layout.overflowListClass;
    }

    function shouldShowSectionSearch(optionCount: number) {
        return optionCount > layout.visibleLimit;
    }

    function sortSelectedFirst<T>(items: T[], isSelected: (item: T) => boolean) {
        return [...items].sort((left, right) => Number(isSelected(right)) - Number(isSelected(left)));
    }

    function getAuthorName(authorLogin: string) {
        const author = allAuthors.find((entry) => entry.login === authorLogin);
        return author?.name && author.name !== authorLogin ? author.name : '';
    }

    function getOwnerDisplay(ownerLogin: string) {
        const owner = allOwners.find((entry) => entry.login === ownerLogin);
        return owner ? getOwnerTypeLabel(owner.type) : 'Owner';
    }

    function getRepoDisplay(repoFullName: string) {
        const repo = allRepos.find((entry) => entry.fullName === repoFullName);

        if (repo) {
            return { name: repo.name, owner: repo.owner };
        }

        const [owner = 'Repo', name = repoFullName] = repoFullName.split('/');
        return { name, owner };
    }

    function getOwnerTypeLabel(type: PullRequestRepoOwner['type']) {
        if (type === 'org') {
            return 'Org';
        }

        if (type === 'user') {
            return 'User';
        }

        return 'Unknown';
    }

    let hasQuery = $derived(query.trim().length > 0);

    // The authors, owners and repos sections differ only in their labels and which field identifies a
    // row. Resolving those differences here leaves one uniform block of markup instead of three
    // near-identical ones that had to be edited in lockstep.
    let filterSections = $derived.by<FilterSectionView[]>(() => {
        // Selected rows float to the top, and a section with a single option offers no choice worth
        // rendering — unless that option is already selected, which the user has to be able to undo.
        function visibleRows<T>(all: T[], selected: string[], isSelected: (item: T) => boolean): T[] {
            return selected.length > 0 || all.length > 1 ? sortSelectedFirst(all, isSelected) : [];
        }

        const owners = visibleRows(allOwners, activeFilters.owners, (owner) => activeFilters.owners.includes(owner.login));
        const authors = visibleRows(allAuthors, activeFilters.authors, (author) => activeFilters.authors.includes(author.login));
        const repos = visibleRows(allRepos, activeFilters.repos, (repo) => activeFilters.repos.includes(repo.fullName));

        return [
            {
                key: 'owners',
                title: 'Owners',
                placeholder: 'Search owners',
                show: hasOwnerFilter || activeFilters.owners.length > 0,
                showSearch: shouldShowSectionSearch(owners.length),
                singleLabel: activeFilters.owners.length === 1 ? activeFilters.owners[0] : '',
                availableSet: new Set(availableOwners.map((owner) => owner.login)),
                rows: owners
                    .filter((owner) => matchesFilterQuery(owner.login, sectionSearch.owners, getOwnerTypeLabel(owner.type)))
                    .map((owner) => ({
                        id: owner.login,
                        primary: owner.login,
                        secondary: owner.type === 'unknown' ? '' : getOwnerTypeLabel(owner.type),
                        secondaryClass: TYPE_LABEL_CLASS,
                    })),
            },
            {
                key: 'authors',
                title: 'Author',
                placeholder: 'Search PR authors',
                show: hasAuthorFilter || activeFilters.authors.length > 0,
                showSearch: shouldShowSectionSearch(authors.length),
                singleLabel: activeFilters.authors.length === 1 ? activeFilters.authors[0] : '',
                availableSet: new Set(availableAuthors.map((author) => author.login)),
                rows: authors
                    .filter((author) => matchesFilterQuery(author.login, sectionSearch.authors, author.name))
                    .map((author) => ({
                        id: author.login,
                        primary: author.login,
                        secondary: getAuthorName(author.login),
                        secondaryClass: AUTHOR_NAME_CLASS,
                    })),
            },
            {
                key: 'repos',
                title: 'Repositories',
                placeholder: 'Search repositories',
                show: hasRepoFilter || activeFilters.repos.length > 0,
                showSearch: shouldShowSectionSearch(repos.length),
                singleLabel: activeFilters.repos.length === 1 ? getRepoDisplay(activeFilters.repos[0]).name : '',
                availableSet: new Set(availableRepos.map((repo) => repo.fullName)),
                rows: repos
                    .filter((repo) => matchesFilterQuery(repo.fullName, sectionSearch.repos, `${repo.name} ${repo.owner}`))
                    .map((repo) => ({
                        id: repo.fullName,
                        primary: repo.name,
                        primaryTitle: repo.fullName,
                        secondary: repo.owner,
                        secondaryClass: TYPE_LABEL_CLASS,
                    })),
            },
        ];
    });
    let activeFilterCount = $derived(countActiveFilters(activeFilters, isToReviewTab ? 'toReview' : 'myPRs'));
    let hasActiveFilters = $derived(activeFilterCount > 0);
    let layout = $derived(fullpageMode ? LAYOUT.full : LAYOUT.compact);
    const filterButtonLabel = 'Toggle filters';
    let draftFilterLabel = $derived(
        activeFilters.drafts === 'only' ? 'Only drafts' :
        activeFilters.drafts === 'include' ? 'Included' :
        'Excluded'
    );
    let reviewStatusLabel = $derived(
        activeFilters.showReviewed ? 'All' : 'Pending only'
    );
    let conflictsLabel = $derived(activeFilters.conflictsOnly ? 'Only conflicts' : 'All');
    let selectedFilterChips = $derived<FilterChip[]>([
        ...(activeFilters.authors.length > 1
            ? activeFilters.authors.map((authorLogin) => ({
                key: `author:${authorLogin}`,
                label: authorLogin,
                value: getAuthorName(authorLogin),
                onRemove: () => toggleFilter('authors', authorLogin),
            }))
            : []),
        ...(activeFilters.owners.length > 1
            ? activeFilters.owners.map((ownerLogin) => ({
                key: `owner:${ownerLogin}`,
                label: ownerLogin,
                value: getOwnerDisplay(ownerLogin),
                onRemove: () => toggleFilter('owners', ownerLogin),
            }))
            : []),
        ...(activeFilters.repos.length > 1
            ? activeFilters.repos.map((repoFullName) => ({
                key: `repo:${repoFullName}`,
                label: getRepoDisplay(repoFullName).name,
                value: getRepoDisplay(repoFullName).owner,
                onRemove: () => toggleFilter('repos', repoFullName),
            }))
            : []),
    ]);
    let hasVisibleChips = $derived(selectedFilterChips.length > 0);

    $effect(() => {
        syncSearchSurfaceState(isSearchOpen);
    });

    // A section that no longer offers a search box must not keep filtering by a stale query.
    $effect(() => {
        for (const filterSection of filterSections) {
            if (!filterSection.showSearch && sectionSearch[filterSection.key]) {
                sectionSearch[filterSection.key] = '';
            }
        }
    });

    $effect(() => {
        if (isFilterOpen === wasFilterOpen) {
            return;
        }

        wasFilterOpen = isFilterOpen;

        if (!isFilterOpen) {
            expandedSections = {
                authors: false,
                owners: false,
                repos: false,
                drafts: false,
                reviewStatus: false,
                conflicts: false,
            };
        }
    });
</script>

{#snippet sectionHeader(key: keyof typeof expandedSections, title: string, meta: string, onClear: (() => void) | null)}
    <button class={`filter-section-header ${layout.headerPad}`} onclick={() => toggleSection(key)}>
        <span class="flex items-center gap-2">
            {#if expandedSections[key]}
                <ChevronDown class="icon-soft" />
            {:else}
                <ChevronRight class="icon-soft" />
            {/if}
            <span>{title}</span>
            {#if !expandedSections[key] && meta}
                <span class="filter-meta">· {meta}</span>
            {/if}
        </span>
        {#if onClear}
            <span
                class="filter-clear"
                role="button"
                tabindex="0"
                onclick={(e) => { e.stopPropagation(); onClear(); }}
                onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onClear(); } }}
            >Clear</span>
        {/if}
    </button>
{/snippet}

{#if isSearchOpen}
<div bind:this={surfaceElement} class={embedded ? 'relative z-20' : `relative z-20 border-b border-soft ${layout.outerPad}`}>
    <div class="space-y-1">
            <div class={`flex items-center ${layout.rowGap}`}>
                <div class="relative min-w-0 flex-1">
                    <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-soft" />
                    <input
                        bind:this={searchInput}
                        type="text"
                        bind:value={query}
                        placeholder="Search PRs, branches, repos, jira"
                        class="field-input popup-search-input"
                    />
                    {#if hasQuery}
                        <button class="unstyled-button absolute right-1.5 top-1/2 -translate-y-1/2 text-soft hover:text-white" onclick={clearSearch} aria-label="Clear search">
                            <X class="h-3.5 w-3.5" />
                        </button>
                    {/if}
                </div>

                <Button
                    className={isFilterOpen || hasActiveFilters ? 'h-7 w-7 shrink-0 px-0 border-(--accent) bg-(--accent)/10 text-(--accent) shadow-[0_0_0_1px_rgba(55,148,255,0.22),0_0_16px_rgba(55,148,255,0.14)] hover:border-(--accent) hover:bg-(--accent)/10 hover:text-(--accent)' : 'h-7 w-7 shrink-0 px-0 border-soft bg-transparent text-soft hover:border-strong hover:bg-(--bg-muted) hover:text-white'}
                    size="icon"
                    variant="ghost"
                    onclick={toggleFilterPanel}
                    aria-label={filterButtonLabel}
                    title={filterButtonLabel}
                >
                    <ListFilter class="h-3.5 w-3.5" />
                </Button>
                {#if hasActiveFilters}
                    <Button
                        className="h-7 w-7 shrink-0 px-0 text-soft hover:text-white hover:bg-(--bg-muted) hover:border-strong cursor-pointer"
                        size="icon"
                        variant="ghost"
                        onclick={clearAllFilters}
                        aria-label="Clear all filters"
                        title="Clear all filters"
                    >
                        <Trash2 class="h-3.5 w-3.5" />
                    </Button>
                {/if}
            </div>

        {#if isFilterOpen}
            {#if hasVisibleChips}
                <div class="flex items-center gap-3">
                    <div class="min-w-0 flex-1 overflow-x-auto scroll-thin">
                        <div class="flex min-w-max items-center gap-1.5 px-0.5">
                            {#each selectedFilterChips as chip (chip.key)}
                                <button
                                    class="filter-chip"
                                    onclick={chip.onRemove}
                                    title={`Remove ${chip.label} filter`}
                                >
                                    <span class="font-medium text-white">{chip.label}</span>
                                    {#if chip.value}
                                        <span class="truncate text-soft">{chip.value}</span>
                                    {/if}
                                    <X class="h-3 w-3 shrink-0" />
                                </button>
                            {/each}
                        </div>
                    </div>
                </div>
            {/if}

            <div class={`overflow-y-auto rounded-xl border border-soft bg-(--bg-panel-strong) ${layout.panelPad} shadow-lg`} style:max-height={layout.filterPanelMaxHeight}>
                <div class={layout.sectionSpace}>
                    <div class="filter-section">
                        {@render sectionHeader('drafts', 'Draft PRs', draftFilterLabel, null)}

                        {#if expandedSections.drafts}
                            <div class={`filter-section-body ${layout.contentPad}`}>
                        <div class={`flex flex-col ${layout.sectionGap}`}>
                            <label class={`filter-label ${layout.labelPad}`}>
                                <input type="radio" name="draft_filter" value="exclude" class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" bind:group={activeFilters.drafts} />
                                <span class="filter-label-text">Don't show drafts</span>
                            </label>
                            <label class={`filter-label ${layout.labelPad}`}>
                                <input type="radio" name="draft_filter" value="include" class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" bind:group={activeFilters.drafts} />
                                <span class="filter-label-text">Include drafts</span>
                            </label>
                            <label class={`filter-label ${layout.labelPad}`}>
                                <input type="radio" name="draft_filter" value="only" class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" bind:group={activeFilters.drafts} />
                                <span class="min-w-0 flex-1 text-soft">Only show drafts</span>
                            </label>
                        </div>
                            </div>
                        {/if}
                    </div>

                    {#if isToReviewTab}
                        <div class="filter-section">
                            {@render sectionHeader('reviewStatus', 'Review Status', reviewStatusLabel, null)}

                            {#if expandedSections.reviewStatus}
                                <div class={`filter-section-body ${layout.contentPad}`}>
                            <div class={`flex flex-col ${layout.sectionGap}`}>
                                <label class={`filter-label ${layout.labelPad}`}>
                                    <input type="radio" name="review_filter" value="pending" checked={!activeFilters.showReviewed} onchange={() => { activeFilters = { ...activeFilters, showReviewed: false }; }} class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" />
                                    <span class="filter-label-text">Only pending review</span>
                                </label>
                                <label class={`filter-label ${layout.labelPad}`}>
                                    <input type="radio" name="review_filter" value="all" checked={activeFilters.showReviewed} onchange={() => { activeFilters = { ...activeFilters, showReviewed: true }; }} class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" />
                                    <span class="min-w-0 flex-1 text-soft">Show reviewed PRs</span>
                                </label>
                            </div>
                                </div>
                            {/if}
                        </div>
                    {/if}

                    <div class="filter-section">
                        {@render sectionHeader('conflicts', 'Merge Conflicts', conflictsLabel, null)}

                        {#if expandedSections.conflicts}
                            <div class={`filter-section-body ${layout.contentPad}`}>
                        <div class={`flex flex-col ${layout.sectionGap}`}>
                            <label class={`filter-label ${layout.labelPad}`}>
                                <input type="radio" name="conflict_filter" value="all" checked={!activeFilters.conflictsOnly} onchange={() => { activeFilters = { ...activeFilters, conflictsOnly: false }; }} class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" />
                                <span class="filter-label-text">All PRs</span>
                            </label>
                            <label class={`filter-label ${layout.labelPad}`}>
                                <input type="radio" name="conflict_filter" value="only" checked={activeFilters.conflictsOnly} onchange={() => { activeFilters = { ...activeFilters, conflictsOnly: true }; }} class="h-3.5 w-3.5 border-soft bg-black/40 text-(--accent) focus:ring-(--accent)" />
                                <span class="min-w-0 flex-1 text-soft">Only PRs with conflicts</span>
                            </label>
                        </div>
                            </div>
                        {/if}
                    </div>

                    {#each filterSections as filterSection (filterSection.key)}
                        {#if filterSection.show}
                            <div class="filter-section">
                                {@render sectionHeader(
                                    filterSection.key,
                                    filterSection.title,
                                    filterSection.singleLabel,
                                    activeFilters[filterSection.key].length > 0 ? () => clearAxis(filterSection.key) : null,
                                )}

                                {#if expandedSections[filterSection.key]}
                                    <div class={`filter-section-body ${layout.contentPad}`}>
                                        {#if filterSection.showSearch}
                                            <div class="mb-2">
                                                <input
                                                    type="text"
                                                    bind:value={sectionSearch[filterSection.key]}
                                                    placeholder={filterSection.placeholder}
                                                    class="filter-search-input"
                                                />
                                            </div>
                                        {/if}
                                        <div class={getSectionListClass(filterSection.rows.length)}>
                                            {#each filterSection.rows as row (row.id)}
                                                {@const selected = activeFilters[filterSection.key].includes(row.id)}
                                                {@const available = filterSection.availableSet.has(row.id)}
                                                <label class={`filter-label ${layout.labelPad} ${selected || available ? '' : 'filter-label-disabled'}`}>
                                                    <input
                                                        type="checkbox"
                                                        class="rounded border-soft bg-black/40 text-(--accent) focus:ring-(--accent)"
                                                        checked={selected}
                                                        disabled={!selected && !available}
                                                        onchange={() => toggleFilter(filterSection.key, row.id)}
                                                    />
                                                    <span class="truncate-text" title={row.primaryTitle}>{row.primary}</span>
                                                    {#if row.secondary}
                                                        <span class={row.secondaryClass}>{row.secondary}</span>
                                                    {/if}
                                                </label>
                                            {/each}
                                        </div>
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    {/each}

                </div>
            </div>
        {/if}
    </div>
</div>
{/if}
