import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'esbuild.shared.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'scripts',
		'samples',
		// The browser extension's build output and build script (not shipped as source).
		'extension/dist',
		'extension/dist-firefox',
		'extension/build.mjs',
		'extension/spike',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The browser extension: Obsidian's plugin review lints every TypeScript file in the
		// repository with these same rules, so the extension is linted here too, with its own
		// tsconfig and the browser-extension globals.
		files: ['extension/src/**/*.ts'],
		languageOptions: {
			globals: { ...globals.serviceworker, chrome: 'readonly' },
			parserOptions: {
				projectService: false,
				project: ['./extension/tsconfig.json'],
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		rules: {
			// Product names keep their own casing in UI text.
			'obsidianmd/ui/sentence-case': ['warn', {
				brands: ['AI ChatBridge', 'ChatGPT', 'ChatGPT Desktop', 'Claude Code', 'Claude Desktop', 'Codex', 'Lumo', 'Proton', 'AI Studio', 'Gemini', 'Google Drive', 'Google', 'Claude', 'Hermes Agent', 'Hermes', 'Obsidian', 'Python', 'Private', 'HERMES_HOME', 'ChatBridge', 'Browser link', 'Chrome', 'Edge', 'Brave'],
				acronyms: ['AI', 'API', 'MB', 'JSON', 'UUID', 'ID', 'README'],
				// Folder names and button labels quoted in descriptions.
				ignoreWords: ['Artifacts', 'Attachments', 'Recent', 'Sync', 'Chats', 'Pair'],
				ignoreRegex: ['^[Xx]{8}-', '^AI chats/'],
			}],
		},
	},
);
