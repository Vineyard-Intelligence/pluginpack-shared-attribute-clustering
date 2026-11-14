#!/usr/bin/env node
// Regenerates plugins/shared-attribute-clustering.manifest.json from the BUILT bundle.
//
// The manifest and the code it describes are two copies of one declaration — versions, scopes,
// params, the description — and the JSON used to be kept by hand next to the source. The registry
// pins a commit and the app reads this JSON from it, so a param or a version the code has and the
// JSON forgot is what the analyst is shown and is not what runs. Generating it means they cannot
// disagree. Same pattern as pluginpack-github and pluginpack-domain-recon.
//
// Usage: node build.mjs && node gen-manifest.mjs
import { writeFileSync } from 'node:fs';

const pack = (await import('./dist/pack.mjs')).default;
if (!pack?.plugins?.length) {
    console.error('dist/pack.mjs has no plugins — run build.mjs first');
    process.exit(1);
}

const platforms = { primary: 'web', web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' } };

/** `author` and `license` are pack-level only: the member schema rejects them. */
function member(m) {
    const { author, license, ...rest } = m;
    return rest;
}

const manifest = {
    identifier: pack.identifier,
    content_type: 'vineyard:pluginpack',
    name: pack.name,
    version: pack.version,
    summary: pack.summary,
    description: pack.description,
    author: { name: 'VINEYARD', url: 'https://github.com/Vineyard-Intelligence' },
    license: 'Apache-2.0',
    icon: 'git-fork',
    platforms,
    plugins: pack.plugins.map((p) => member(p.manifest)),
};

writeFileSync(
    new URL('./plugins/shared-attribute-clustering.manifest.json', import.meta.url),
    `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`wrote plugins/shared-attribute-clustering.manifest.json (${manifest.plugins.length} plugin)`);
