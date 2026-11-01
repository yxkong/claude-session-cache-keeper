import os from 'node:os';
import path from 'node:path';
export function homeFrom(env = process.env) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error('找不到用户主目录。');
  return home;
}
export function rootsFor({ platform = process.platform, env = process.env, home = homeFrom(env) } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.CACHE_KEEPER_DATA_DIR) return [p.resolve(env.CACHE_KEEPER_DATA_DIR)];
  const roots = [p.join(home, '.cache-keeper')];
  if (platform === 'darwin') roots.push(p.join(home, 'Library/Application Support/ClaudeCacheKeeper'));
  return roots;
}
export function executableCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const paths = (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  paths.push(p.join(home, '.local', 'bin'), p.join(home, '.bun', 'bin'));
  if (platform === 'win32' && env.APPDATA) paths.push(p.join(env.APPDATA, 'npm'));
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  return [...new Set(paths.flatMap(dir => names.map(name => p.join(dir, name))))];
}
