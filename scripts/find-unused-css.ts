#!/usr/bin/env bun
/**
 * Find unused CSS classes in app.css not referenced in any source file.
 * Usage: bun scripts/find-unused-css.ts
 */

import { globSync, readFileSync } from 'node:fs';

const CSS_FILE = 'extension/src/styles/app.css';
const SRC = 'extension/src/**/*.{svelte,ts,js,html}';
const SERVICE_WORKER = 'extension/service-worker.ts';

// 1. Read app.css and extract class selectors
const css = readFileSync(CSS_FILE, 'utf8');
const classRegex = /\.([a-zA-Z_][\w-]*)\s*[{,:]/g;
const classes = new Set<string>();
let match: RegExpExecArray | null;
while ((match = classRegex.exec(css)) !== null) {
	const name = match[1];
	// Skip pseudo-classes/elements and Tailwind utilities
	if (
		/^(active|after|before|checked|disabled|empty|enabled|first|focus|focus-within|focus-visible|hover|last|link|not|nth-child|required|root|target|valid|visited|placeholder|selection|marker|backdrop)$/.test(
			name,
		)
	)
		continue;
	classes.add(name);
}

// 2. Scan all source files for usage
const files = [...globSync(SRC), SERVICE_WORKER];
const usageCount = new Map<string, number>();
for (const c of classes) usageCount.set(c, 0);

for (const file of files) {
	const content = readFileSync(file, 'utf8');
	for (const c of classes) {
		if (new RegExp(`\\b${c.replace(/[-]/g, '[-]')}\\b`).test(content)) {
			usageCount.set(c, usageCount.get(c) + 1);
		}
	}
}

// 3. Report
const unused = [...classes].filter((c) => usageCount.get(c) === 0);

console.log(`\n📊 CSS Class Analysis — ${CSS_FILE}\n`);
console.log(`   Total classes:  ${classes.size}`);
console.log(`   Unused:         ${unused.length}\n`);

if (unused.length > 0) {
	console.log('🗑️  Unused CSS classes (safe to delete):\n');
	for (const c of unused.sort()) console.log(`   .${c}`);
	console.log('');
} else {
	console.log('✅ All CSS classes are referenced in source files.\n');
}
