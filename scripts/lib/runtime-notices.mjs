import fs from 'node:fs/promises';
import path from 'node:path';
export async function runtimeNotices(root,runtime) {
  const entries=[];
  async function modules(directory){
    for(const name of await fs.readdir(directory)){
      if(name.startsWith('.'))continue;
      const folder=path.join(directory,name);
      if(name.startsWith('@')){await modules(folder);continue;}
      const pkg=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));
      const names=await fs.readdir(folder);const license=names.find(n=>/^(?:licen[sc]e|copying)(?:\.(?:md|txt))?$/i.test(n));
      const supplemental=pkg.name==='lazy-val' && pkg.version==='1.0.5' && pkg.license==='MIT' ? path.join(root,'assets/licenses/lazy-val-1.0.5.txt') : null;
      if(!license && !supplemental)throw new Error(`Missing runtime license: ${pkg.name}`);
      entries.push({name:pkg.name,version:pkg.version,text:await fs.readFile(license ? path.join(folder,license) : supplemental,'utf8')});
      const nested=path.join(folder,'node_modules');if(await fs.stat(nested).then(s=>s.isDirectory()).catch(()=>false))await modules(nested);
    }
  }
  await modules(path.join(runtime,'node_modules'));
  const file=path.join(root,'THIRD_PARTY_NOTICES.md');const intro=(await fs.readFile(file,'utf8')).split('## Bundled runtime dependencies')[0];
  const unique=[...new Map(entries.map(e=>[`${e.name}@${e.version}`,e])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  await fs.writeFile(file,intro+'## Bundled runtime dependencies\n\n以下许可来自锁定的生产依赖；各包内同时保留原许可文件。Electron 与 Chromium 的许可随运行时保留。\n\n'+unique.map(e=>`### ${e.name} ${e.version}\n\n\`\`\`text\n${e.text.trim()}\n\`\`\`\n`).join('\n'));
}
