// Turning a branch name into a Jira link is one job. The ticket extraction, the base-URL
// sanitising and the URL assembly are steps in it, not things a caller should reassemble.

/** Jira project keys are letters, the issue number digits. Case-insensitive: branches use both. */
const TICKET_PATTERN = /([A-Z]+-\d+)/i;

function parseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

export function sanitizeJiraUrl(url: string): string {
	if (!url) return '';
	const trimmed = url.trim();
	if (!trimmed) return '';

	// Only a real `scheme://` prefix counts as already-schemed. Prepending https:// to everything
	// turned `ftp://x.com` into the host `ftp` — a clean parse that reached the origin below and made
	// the protocol check unreachable. A bare `host:8080` still has to take the prefix, so the test is
	// on `://`, not on the colon.
	const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
	const parsed = parseUrl(hasScheme ? trimmed : `https://${trimmed}`);
	if (!parsed) return '';

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return '';
	}

	return parsed.origin + contextPath(parsed);
}

/**
 * Where Jira's own routes start. Everything from the first of these on is a pasted deep link, not
 * part of the base. `jira` is deliberately absent: on Data Center it is the usual context path.
 */
const JIRA_ROUTES = new Set(['browse', 'secure', 'projects', 'issues', 'plugins', 'rest', 'servicedesk', 'login.jsp']);

/**
 * Self-hosted Jira can live under a context path (`https://example.com/jira`), so the path before
 * the first Jira route is part of the base. Cloud never has one, and its own routes start with
 * `/jira/...`, so an atlassian.net URL is always cut back to the origin.
 */
function contextPath(url: URL): string {
	if (isCloud(url)) return '';

	const segments = url.pathname.split('/').filter(Boolean);
	const end = segments.findIndex((segment) => JIRA_ROUTES.has(segment.toLowerCase()));
	const kept = end === -1 ? segments : segments.slice(0, end);

	return kept.length ? `/${kept.join('/')}` : '';
}

function isCloud(url: URL): boolean {
	return url.hostname === 'atlassian.net' || url.hostname.endsWith('.atlassian.net');
}

/** The landing page for a sanitized base: Cloud's "For you", Data Center's dashboard. */
export function jiraDashboardUrlFor(baseUrl: string): string {
	const base = sanitizeJiraUrl(baseUrl);
	if (!base) return '';

	return isCloud(new URL(base)) ? `${base}/jira/for-you` : `${base}/secure/Dashboard.jspa`;
}

/** The branch-name ticket rule, shared with the popup's search index so the two cannot disagree. */
export function jiraTicketFor(branchName: string): string {
	return branchName?.match(TICKET_PATTERN)?.[1]?.toUpperCase() || '';
}

export interface JiraLink {
	ticket: string;
	url: string;
}

export function jiraLinkFor(branchName: string, baseUrl: string): JiraLink | null {
	if (!branchName || !baseUrl) return null;

	const ticket = jiraTicketFor(branchName);
	const origin = sanitizeJiraUrl(baseUrl);
	if (!ticket || !origin) return null;

	return { ticket, url: `${origin}/browse/${ticket}` };
}
