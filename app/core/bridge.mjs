import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { validID, validSnapshot, online, isCurrent, validatePolicy } from './contracts.mjs';
import { TranscriptTitles } from './titles.mjs';
import { homeFrom } from './platform.mjs';

async function jsonFile(file, limit) {
  const stat = await fs.stat(file);
  if (stat.size > limit) throw new Error('状态文件过大。');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export class BridgeRepository {
  constructor({ roots, transcriptsRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeFrom(), '.claude'), 'projects') }) {
    if (!Array.isArray(roots) || !roots.length) throw new Error('缺少数据目录。');
    this.roots = [...new Set(roots.map(r => path.resolve(r)))]; this.rows = new Map();
    this.titles = new TranscriptTitles(transcriptsRoot); this.warnings = [];
  }
  async prepare() {
    for (const dir of ['sessions', 'controls']) await fs.mkdir(path.join(this.roots[0], dir), { recursive: true, mode: 0o700 });
  }
  async refresh() {
    await this.prepare(); this.warnings = [];
    const seen = new Set();
    for (const root of this.roots) {
      let files;
      try { files = await fs.readdir(path.join(root, 'sessions')); }
      catch (error) { if (error.code !== 'ENOENT') this.warnings.push('部分会话状态目录无法读取。'); continue; }
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!validID(id) || seen.has(id)) continue;
        try {
          const snapshot = await jsonFile(path.join(root, 'sessions', name), 64_000);
          if (!validSnapshot(snapshot, id)) continue;
          this.rows.set(id, { snapshot, root }); seen.add(id);
        } catch { /* Keep the last valid snapshot during a non-atomic mod write. */ }
      }
    }
    const result = [];
    for (const { snapshot: s, root } of this.rows.values()) {
      let enabled = s.enabled, pending = false, policy = s.policy;
      try {
        const c = await jsonFile(path.join(root, 'controls', `${s.id}.json`), 16_000);
        if (c.schema === 1 && c.id === s.id && typeof c.enabled === 'boolean' && typeof c.revision === 'string' && validatePolicy(c.policy)) {
          if (c.revision !== s.controlRevision) { enabled = c.enabled; policy = c.policy; pending = true; }
        }
      } catch { /* A missing control is a normal default-off connection. */ }
      const title = await this.titles.title(s.sessionId).catch(() => null);
      result.push({ ...s, title: title || s.title || s.sessionId, enabled, policy, pending, online: online(s), current: isCurrent(s) });
    }
    return result.sort((a, b) => Number(b.online) - Number(a.online) || b.heartbeat - a.heartbeat);
  }
  async save(id, input) {
    if (!validID(id) || !this.rows.has(id)) throw new Error('找不到这条会话，请刷新后再试。');
    if (typeof input?.enabled !== 'boolean' || !validatePolicy(input.policy)) throw new Error('间隔需为 30～280 秒的整数，最短不能大于最长；尝试次数需为正整数，token 门槛需为 0～1000 万的整数。');
    const row = this.rows.get(id);
    const latest = await jsonFile(path.join(row.root, 'sessions', `${id}.json`), 64_000).catch(() => row.snapshot);
    if (!validSnapshot(latest, id)) throw new Error('会话状态无效。');
    if (input.enabled && !online(latest)) throw new Error('会话已离线，不能开启保活。');
    if (input.enabled && !isCurrent(latest)) throw new Error('旧版执行器连接仅可停止；请更新插件并重新打开会话。');
    if (input.policy.maxAttempts > 6 && latest.capabilities?.customAttemptBudget !== true) throw new Error('当前会话仍使用限制次数的旧执行器。请先安装新版连接插件，待任务结束后重载，再保存此设置。');
    const control = { schema: 1, id, revision: randomUUID(), enabled: input.enabled, policy: { ...input.policy } };
    await atomicJSON(path.join(row.root, 'controls', `${id}.json`), control);
    return control;
  }
  async stopAll({ legacyOnly = false } = {}) {
    const rows = await this.refresh();
    const errors = [];
    for (const s of rows) {
      if (!s.enabled || (legacyOnly && s.current)) continue;
      try { await this.save(s.id, { enabled: false, policy: s.policy }); } catch (e) { errors.push(e.message); }
    }
    if (errors.length) throw new Error('部分会话未能停止：' + errors.join('；'));
  }
}
