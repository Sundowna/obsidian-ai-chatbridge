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
		// The browser extension is not Obsidian code: Obsidian's rules do not apply there.
		// It is type-checked with its own tsconfig by `npm run build:extension`.
		'extension',
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
