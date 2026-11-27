// Builds the Browser link extension: extension/dist for Chrome, Edge and Brave (load that folder
// unpacked), extension/dist-firefox for Firefox (about:debugging → Load Temporary Add-on).
//   npm run build:extension

import esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
	entryPoints: { background: join(here, 'src/background.ts'), options: join(here, 'src/options.ts') },
	outdir: out,
	bundle: true,
	format: 'iife',
	target: 'chrome116',
	// Page functions are copied into tabs as their source text: no renaming, no helpers.
	minify: false,
	keepNames: false,
	legalComments: 'none',
	logLevel: 'warning',
});
copyFileSync(join(here, 'manifest.json'), join(out, 'manifest.json'));
copyFileSync(join(here, 'src/options.html'), join(out, 'options.html'));
cpSync(join(here, 'icons'), join(out, 'icons'), { recursive: true });
console.log(`Extension built: ${out}`);

// Firefox: the same code; its manifest runs the background as a script (Firefox has no
// extension service workers) and names the add-on, as Firefox requires.
const ff = join(here, 'dist-firefox');
rmSync(ff, { recursive: true, force: true });
mkdirSync(ff, { recursive: true });
for (const f of ['background.js', 'options.js', 'options.html']) copyFileSync(join(out, f), join(ff, f));
cpSync(join(here, 'icons'), join(ff, 'icons'), { recursive: true });
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
delete manifest.externally_connectable; // Chrome only; Firefox switches the tab by watching it load
manifest.background = { scripts: ['background.js'] };
// data_collection_permissions: Mozilla asks every add-on it signs to say what it collects; this one collects nothing.
manifest.browser_specific_settings = { gecko: { id: 'ai-chatbridge-browser-link@sundowna', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } };
writeFileSync(join(ff, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Extension built for Firefox: ${ff}`);
