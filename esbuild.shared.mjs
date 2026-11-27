// Bundle options shared by the plugin build (esbuild.config.mjs) and the test that checks the
// bundle (scripts/test-bundle.mjs), so the test proves what the real build does.
import { builtinModules } from 'node:module';

export const pluginBundle = {
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtinModules,
		// Optional speed-ups of `ws`; it works without them.
		'bufferutil',
		'utf-8-validate',
	],
	// The Browser link server runs in Obsidian's Node side: take `ws` itself, not its browser stub
	// (esbuild builds for the browser here). It is loaded only when the server starts (desktop).
	alias: { ws: './node_modules/ws/index.js' },
	format: 'cjs',
	target: 'es2021',
	treeShaking: true,
};
