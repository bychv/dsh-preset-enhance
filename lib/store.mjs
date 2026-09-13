import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One process owns a DSH home. Serialized atomic updates prevent lost editor writes. */
export class PresetStore {
  constructor(file) { this.file = file; this.tail = Promise.resolve(); }
  async read() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      if (state.version !== 1) throw new Error('不支持的预设数据库版本');
      state.defaultPresetId ??= null;
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, revision: 0, defaultPresetId: null, presets: [], bindings: {}, global: {}, sessions: {} };
    }
  }
  transaction(fn) {
    const work = this.tail.then(async () => {
      const state = await this.read();
      const result = await fn(state);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, this.file);
      return result;
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
