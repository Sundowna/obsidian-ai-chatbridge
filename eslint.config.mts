import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'scripts',
		'samples',
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
				brands: ['AI ChatBridge', 'ChatGPT', 'ChatGPT Desktop', 'Claude Code', 'Claude Desktop', 'Codex', 'Lumo', 'Proton', 'AI Studio', 'Gemini', 'Google Drive', 'Google', 'Claude'],
				acronyms: ['AI', 'API', 'MB', 'JSON', 'UUID', 'ID'],
				// Folder names and button labels quoted in descriptions.
				ignoreWords: ['Artifacts', 'Attachments', 'Recent', 'Sync', 'Chats'],
				ignoreRegex: ['^[Xx]{8}-', '^AI chats/'],
			}],
		},
	},
);
