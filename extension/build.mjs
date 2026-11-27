// Builds the Browser link extension into extension/dist (load that folder unpacked).
//   npm run build:extension

import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
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
console.log(`Extension built: ${out}`);
