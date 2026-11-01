import fs from 'node:fs/promises';
import path from 'node:path';
import { validID } from './contracts.mjs';
export class TranscriptTitles {
  constructor(root) { this.root = root; this.paths = new Map(); this.cache = new Map(); }
  async title(id) {
    if (!validID(id)) return null;
    let file = this.paths.get(id);
    if (!file) {
      for (const entry of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(this.root, entry.name, `${id}.jsonl`);
        if ((await fs.stat(candidate).catch(() => null))?.isFile()) { file = candidate; this.paths.set(id, file); break; }
      }
    }
    if (!file) return null;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return null;
    const old = this.cache.get(id);
    if (old?.size === stat.size && old?.mtime === stat.mtimeMs) return old.title;
    const grew = old && stat.size >= old.size;
    const start = Math.max(0, stat.size - 8 * 1024 * 1024, grew ? old.size - 4096 : 0);
    let title = grew ? old.title : null;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').reverse()) {
        if (!line.includes('custom-title') && !line.includes('agent-name')) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        const value = row.type === 'custom-title' ? row.customTitle : row.type === 'agent-name' ? row.agentName : null;
        if (typeof value !== 'string') continue;
        const clean = value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120);
        if (clean) { title = clean; break; }
      }
    } finally { await handle.close(); }
    this.cache.set(id, { size: stat.size, mtime: stat.mtimeMs, title });
    return title;
  }
}
