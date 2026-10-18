#!/usr/bin/env bun
// Generates og.png in code (satori + resvg) from the site's real brand
// tokens/copy — no design tool, no AI image gen, not checked into git.
// Output dir is a CLI arg: 'public' for dev (vite's static root), 'dist' for
// build/preview (vite's build output).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const root = path.dirname(fileURLToPath(import.meta.url));
const websiteDir = path.join(root, '..', 'website');
const publicDir = path.join(websiteDir, 'public');
const outDir = path.join(websiteDir, process.argv[2] || 'dist');
const cacheDir = path.join(websiteDir, '.cache', 'fonts');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const WIDTH = 1200;
const HEIGHT = 630;

// Design tokens copied from src/app.css :root (satori can't read system CSS).
const navy = '#0a1020';
const crimson = '#e0294e';
const violet = '#6b46ff';
const blue = '#3794ff';
const soft = '#9da1a6';
const dim = '#80868b';
const borderStrong = '#4f4f4f';

// Google Fonts serves WOFF (satori-compatible; WOFF2 is not) to browsers that
// predate WOFF2 support.
const LEGACY_UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/30.0.1599.17 Safari/537.36';

async function loadGoogleFont(family: string, weight: number) {
	const cacheFile = path.join(cacheDir, `${family.replace(/\s+/g, '-')}-${weight}.woff`);
	if (existsSync(cacheFile)) return readFileSync(cacheFile);

	const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, {
		headers: { 'User-Agent': LEGACY_UA },
	}).then((r) => r.text());
	const url = css.match(/url\(([^)]+)\)/)?.[1];
	if (!url) throw new Error(`No font URL found for ${family} ${weight}`);
	// DOM lib + @types/node both declare Response.arrayBuffer(), yielding a union
	// return type Buffer.from()'s overloads can't match directly — cast through.
	const arrayBuffer = (await fetch(url).then((r) => r.arrayBuffer())) as ArrayBuffer;
	const buf = Buffer.from(new Uint8Array(arrayBuffer));
	writeFileSync(cacheFile, buf);
	return buf;
}

function dataUri(file: string, mime: string) {
	return `data:${mime};base64,${readFileSync(path.join(publicDir, file)).toString('base64')}`;
}

const [regular, extrabold] = await Promise.all([loadGoogleFont('Inter', 400), loadGoogleFont('Inter', 800)]);

const logo = dataUri('icon-1024.png', 'image/png');
const chrome = dataUri('chrome.svg', 'image/svg+xml');
const firefox = dataUri('firefox.png', 'image/png');

function browserChip(icon: string, label: string) {
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				alignItems: 'center',
				gap: 10,
				padding: '10px 18px',
				borderRadius: 12,
				border: `1px solid ${borderStrong}`,
				color: '#ffffff',
				fontSize: 18,
			},
			children: [
				{ type: 'img', props: { src: icon, width: 20, height: 20 } },
				{ type: 'span', props: { children: label } },
			],
		},
	};
}

const tree = {
	type: 'div',
	props: {
		style: {
			width: WIDTH,
			height: HEIGHT,
			display: 'flex',
			flexDirection: 'column',
			justifyContent: 'space-between',
			padding: '72px 80px',
			backgroundColor: navy,
			backgroundImage: `radial-gradient(900px 500px at 15% -10%, rgba(107,70,255,0.35), rgba(107,70,255,0) 60%), radial-gradient(700px 420px at 100% 0%, rgba(55,148,255,0.28), rgba(55,148,255,0) 60%), linear-gradient(180deg, ${navy} 0%, #070a12 100%)`,
			fontFamily: 'Inter',
		},
		children: [
			{
				type: 'div',
				props: {
					style: { display: 'flex', alignItems: 'center', gap: 14 },
					children: [
						{ type: 'img', props: { src: logo, width: 56, height: 56, style: { borderRadius: 14 } } },
						{ type: 'span', props: { style: { fontSize: 28, fontWeight: 800, color: '#ffffff' }, children: 'PR Pulse' } },
					],
				},
			},
			{
				type: 'div',
				props: {
					style: { display: 'flex', flexDirection: 'column', gap: 20 },
					children: [
						{
							type: 'span',
							props: {
								style: { fontSize: 15, letterSpacing: 3, textTransform: 'uppercase', color: dim },
								children: 'PR Pulse · Browser Extension',
							},
						},
						{
							type: 'span',
							props: {
								style: { fontSize: 84, fontWeight: 800, letterSpacing: -3, lineHeight: 1, color: '#f4f6f8' },
								children: 'Say No to Navigation',
							},
						},
						{
							type: 'span',
							props: {
								style: { fontSize: 26, color: soft, maxWidth: 760, lineHeight: 1.5 },
								children: 'Every pull request that needs you, a single click away — right in your toolbar.',
							},
						},
					],
				},
			},
			{
				type: 'div',
				props: {
					style: { display: 'flex', flexDirection: 'column', gap: 20 },
					children: [
						{
							type: 'div',
							props: {
								style: {
									width: 120,
									height: 4,
									borderRadius: 999,
									backgroundImage: `linear-gradient(120deg, ${crimson} 0%, ${violet} 52%, ${blue} 100%)`,
								},
							},
						},
						{
							type: 'div',
							props: {
								style: { display: 'flex', alignItems: 'center', gap: 16 },
								children: [browserChip(chrome, 'Chrome'), browserChip(firefox, 'Firefox')],
							},
						},
					],
				},
			},
		],
	},
};

const svg = await satori(tree, {
	width: WIDTH,
	height: HEIGHT,
	fonts: [
		{ name: 'Inter', data: regular, weight: 400, style: 'normal' },
		{ name: 'Inter', data: extrabold, weight: 800, style: 'normal' },
	],
});

const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
writeFileSync(path.join(outDir, 'og.png'), png);
console.log(`Wrote ${path.relative(path.join(root, '..'), outDir)}/og.png`);
