import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseAssets } from './lib/release-assets.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=process.argv.find(a=>a.startsWith('--directory='))?.slice(12)||'release';
const catalog=await releaseAssets({root,directory:path.resolve(root,dir)});
console.log(`Release metadata: app ${catalog.app.version}, plugin ${catalog.plugin.version}, ${catalog.app.assets.length} application artifacts.`);
