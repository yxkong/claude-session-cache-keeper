import fs from 'node:fs/promises';
import path from 'node:path';
import spawn from 'cross-spawn';
const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
const config=JSON.parse(await fs.readFile('release-config.json','utf8'));
if(config.repository!==process.env.GITHUB_REPOSITORY)throw new Error('Release repository must match release-config.json.');
const tag=`v${pkg.version}`;
if(process.env.GITHUB_REF_TYPE==='tag' && process.env.GITHUB_REF_NAME!==tag)throw new Error('Tag and application version differ.');
const directory='release/native';
const files=(await fs.readdir(directory)).filter(n=>/^(?:CacheKeeper-|tauri-latest\.json$|cachekeeper-update\.json$|SHA256SUMS\.txt$)/.test(n)).map(n=>path.join(directory,n));
const run=args=>{const r=spawn.sync('gh',args,{stdio:'inherit'});if(r.error||r.status!==0)throw r.error||new Error('GitHub Release command failed.');};
// A draft is invisible to clients until every asset has uploaded successfully.
const exists=spawn.sync('gh',['release','view',tag,'--repo',config.repository,'--json','isDraft'],{encoding:'utf8'});
if(exists.status===0){if(!JSON.parse(exists.stdout).isDraft)throw new Error('Refusing to replace an already published release.');}
else run(['release','create',tag,'--repo',config.repository,'--target',process.env.GITHUB_SHA,'--draft','--title',`CacheKeeper ${pkg.version}`,'--notes-file','CHANGELOG.md']);
run(['release','upload',tag,...files,'--repo',config.repository,'--clobber']);
run(['release','edit',tag,'--repo',config.repository,'--draft=false','--latest']);
