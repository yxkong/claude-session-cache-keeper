import fs from 'node:fs/promises';
import path from 'node:path';

export async function stageMacApp(source, stage) {
  const inside = (parent,child) => { const relative = path.relative(path.resolve(parent),path.resolve(child)); return relative === '' || (relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)); };
  if (inside(source,stage) || inside(stage,source)) throw new Error('App source and disposable staging directory must be separate.');
  await fs.rm(stage,{recursive:true,force:true});
  await fs.mkdir(stage, { recursive: true });
  // Node otherwise resolves framework links to absolute paths on the build host.
  await fs.cp(source, path.join(stage, path.basename(source)), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}
