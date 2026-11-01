import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import spawn from 'cross-spawn';
import semver from 'semver';
import { randomUUID } from 'node:crypto';
import { PLUGIN_FILES } from './release-contract.mjs';
import { executableCandidates } from './platform.mjs';

export function runCLI(executable, args, { timeout = 30_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let text = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('CLI 执行超时，请检查 Claude Code 安装状态。')); }, timeout);
    function finish(error) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(text); }
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      text += chunk.toString('utf8'); if (text.length > 512_000) { child.kill(); finish(new Error('CLI 输出超过限制。')); }
    });
    child.on('error', e => finish(new Error(`无法运行 Claude Code CLI：${e.code || e.message}`)));
    child.on('close', code => finish(code === 0 ? null : new Error(text.trim().slice(-1800) || `CLI 退出码 ${code}`)));
  });
}
export async function findCLI({ platform = process.platform, env = process.env, home = os.homedir(), run = runCLI } = {}) {
  for (const candidate of executableCandidates({ platform, env, home })) {
    try { await fs.access(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  if (platform !== 'win32') {
    const shells = platform === 'darwin' ? ['/bin/zsh', '/bin/bash'] : ['/bin/bash', '/bin/sh'];
    for (const shell of shells) {
      try {
        const found = (await run(shell, ['-lc', 'command -v claude'], { timeout: 10_000, env })).trim().split('\n').at(-1);
        if (found?.startsWith('/') && !found.includes('\0')) { await fs.access(found, fs.constants.X_OK); return found; }
      } catch { /* A shell or its profile may be unavailable. */ }
    }
  }
  throw new Error('未找到 Claude Code CLI。安装并登录 CLI 后再连接。');
}

export class PluginInstaller {
  constructor({ resources, dataRoot, repository, cli, run = runCLI }) {
    this.resources = resources; this.dataRoot = dataRoot; this.repository = repository; this.cli = cli; this.run = run; this.busy = false;
  }
  async installed() {
    const cli = this.cli || await findCLI();
    const listed = JSON.parse(await this.run(cli, ['plugin','list','--json']));
    if (!Array.isArray(listed)) throw new Error('无法读取 CLI 插件列表。');
    return listed.find(p => p.id === 'session-cache-keeper@yxkong-cache-tools') || null;
  }
  async stage(resources) {
    const dest = path.join(this.dataRoot, 'marketplace');
    const stage = path.join(this.dataRoot, 'updates', randomUUID(), 'marketplace');
    const backup = stage + '.previous'; let hadPrevious = false;
    for (const relative of PLUGIN_FILES) {
      const target = path.join(stage, relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, await fs.readFile(path.join(resources, relative)), { mode: 0o600 });
    }
    try { await fs.rename(dest, backup); hadPrevious = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.rename(stage, dest); }
    catch (e) { if (hadPrevious) await fs.rename(backup, dest); throw e; }
    return { source:dest, finish:async success => {
      if (success) { if (hadPrevious) await fs.rm(backup,{recursive:true,force:true}); }
      else { await fs.rename(dest, stage); if (hadPrevious) await fs.rename(backup,dest); }
    } };
  }
  async install({ resources = this.resources } = {}) {
    if (this.busy) throw new Error('连接插件正在安装，请稍候。');
    this.busy = true; let legacy, staged, success = false;
    try {
      const cli = this.cli || await findCLI();
      const listed = JSON.parse(await this.run(cli, ['plugin', 'list', '--json']));
      if (!Array.isArray(listed)) throw new Error('无法读取 CLI 插件列表。');
      legacy = listed.find(p => p.id === 'session-cache-keeper@personal-cache-tools' && p.enabled);
      const newExists = listed.some(p => p.id === 'session-cache-keeper@yxkong-cache-tools');
      const candidate = JSON.parse(await fs.readFile(path.join(resources,'plugin/.claude-plugin/plugin.json'),'utf8'));
      const installed = listed.find(p => p.id === 'session-cache-keeper@yxkong-cache-tools');
      if (!semver.valid(candidate.version) || (semver.valid(installed?.version) && semver.gt(installed.version,candidate.version))) throw new Error('已安装的插件版本较新，拒绝降级。请使用“检查更新”获取新版。');
      staged = await this.stage(resources); const source = staged.source;
      if (legacy) {
        await this.repository.stopAll({ legacyOnly: true });
        await this.run(cli, ['plugin', 'disable', legacy.id, '--scope', 'user']);
      }
      let newInstalled = false;
      try {
        const raw = await this.run(cli, ['plugin', 'install', 'session-cache-keeper', '--marketplace', source, '--scope', 'user', '--json']);
        const result = JSON.parse(raw.trim().split('\n').filter(line => line.startsWith('{')).at(-1) || '{}');
        if (result.outcome !== 'ok') throw new Error(result.message || '连接插件未确认安装成功。');
        newInstalled = true;
        // An existing local install still needs update after the staged source changed.
        if (newExists) {
          const update = JSON.parse((await this.run(cli, ['plugin', 'update', 'session-cache-keeper@yxkong-cache-tools', '--scope', 'user', '--json'])).trim().split('\n').filter(line => line.startsWith('{')).at(-1) || '{}');
          if (update.outcome !== 'ok') throw new Error(update.message || '连接插件未确认更新成功。');
        }
      } catch (error) {
        if (legacy) {
          if (newInstalled) {
            await this.repository.stopAll();
            try { await this.run(cli, ['plugin', 'disable', 'session-cache-keeper@yxkong-cache-tools', '--scope', 'user']); }
            catch { throw new Error('新版安装未完成，且未能确认停用；旧版未重新开启，请检查 CLI 插件状态。'); }
          }
          try { await this.run(cli, ['plugin', 'enable', legacy.id, '--scope', 'user']); }
          catch { throw new Error(error.message + '；旧插件恢复失败，请检查 CLI 插件状态。'); }
        }
        throw error;
      }
      success = true;
      return '连接插件已安装。请在目标会话重载插件；若仍报告旧版，待任务完成后重启 Claude。新连接默认关闭。';
    } finally { try { await staged?.finish(success); } finally { this.busy = false; } }
  }
}
