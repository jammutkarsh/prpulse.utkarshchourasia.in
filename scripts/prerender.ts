#!/usr/bin/env bun
// Prerenders App.svelte to static HTML via Svelte's built-in server renderer
// (svelte/server) so `curl` and non-JS crawlers get the real skeleton —
// headings, FAQ text, links — instead of an empty <div id="app">. No
// headless browser: Vite does a real SSR build of the component (same
// `generate: 'server'` output a framework like SvelteKit produces) and
// svelte/server.render() turns it into a string. Client-side, main.ts
// hydrates over this markup, so the interactive/JS-heavy bits (live PR
// fetch, popup demo) still take over exactly as before.
//
// A dev-server ssrLoadModule() was tried first and rejected: Vite's dev
// pipeline always compiles Svelte in dev mode (bind:this ownership
// tracking), which assumes a real browser mount and crashes when a
// component is rendered standalone like this. A real `vite build` with
// `build.ssr` forces the production/non-dev compile path instead.
import { build } from 'vite';
import { render } from 'svelte/server';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(root, '..', 'website');
const outDir = path.join(projectRoot, process.argv[2] || 'dist');
const indexPath = path.join(outDir, 'index.html');
const ssrOutDir = path.join(projectRoot, '.ssr-tmp');

await build({
	root: projectRoot,
	logLevel: 'warn',
	build: {
		ssr: 'src/App.svelte',
		outDir: '.ssr-tmp',
		emptyOutDir: true,
		write: true,
		rollupOptions: { output: { format: 'es', entryFileNames: 'app.mjs' } },
	},
	// lucide-svelte's own barrel file omits the .js extension on a relative
	// export, invalid under strict Node ESM. Vite's bundler tolerates it;
	// left externalized (Vite's SSR default), Node/Tailwind's own resolvers
	// don't. Bundling it inline sidesteps the broken import entirely.
	ssr: { noExternal: ['lucide-svelte'] },
});

try {
	const { default: App } = await import(path.join(ssrOutDir, 'app.mjs'));
	const { head, body } = render(App);

	let html = readFileSync(indexPath, 'utf8');
	html = html.replace('<div id="app"></div>', `<div id="app">${body}</div>`);
	if (head) html = html.replace('</head>', `${head}</head>`);
	writeFileSync(indexPath, html);
	console.log(`Prerendered skeleton into ${path.relative(projectRoot, indexPath)}`);
} finally {
	rmSync(ssrOutDir, { recursive: true, force: true });
}
