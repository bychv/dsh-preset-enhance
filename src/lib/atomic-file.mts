import { randomUUID } from 'node:crypto';
import { open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

const LEGACY_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;
const TEMP_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const WINDOWS_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Retry replacement of the same file, without repeating the transaction callback. */
export async function writeAtomicFile(file: string, content: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const temp = file + '.write-' + randomUUID() + '.tmp';
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      signal?.throwIfAborted();
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    const delays = [20, 40, 80, 160];
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await rename(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (process.platform !== 'win32' || !WINDOWS_RENAME_ERRORS.has(code ?? '') || attempt >= delays.length) throw error;
        await wait(delays[attempt], undefined, { signal });
      }
    }
  } catch (error) {
    await unlink(temp).catch(cleanupError => {
      if (!isErrno(cleanupError, 'ENOENT')) console.warn('preset-enhance: could not remove the temporary file', cleanupError);
    });
    throw error;
  }
}

/** Reclaim abandoned files while holding the same lock used by current writers. */
export async function cleanAtomicTemps(file: string): Promise<void> {
  const directory = dirname(file);
  const prefix = basename(file) + '.';
  const now = Date.now();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    const suffix = entry.name.slice(prefix.length, -4);
    const current = suffix.startsWith('write-') && TEMP_UUID.test(suffix.slice(6));
    if (!current && !TEMP_UUID.test(suffix)) continue;
    const path = join(directory, entry.name);
    try {
      // Older builds did not hold this lock. Give their temp files a grace period.
      if (current || now - (await stat(path)).mtimeMs >= LEGACY_TEMP_AGE_MS) await unlink(path);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) console.warn('preset-enhance: could not remove an abandoned temporary file', error);
    }
  }
}

/** Resolve symlink aliases, including a symlinked parent of a new state file. */
export async function atomicFilePath(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    return join(await realpath(dirname(file)), basename(file));
  }
}

/**
 * An empty SQLite sidecar provides an OS-released writer lock. State remains JSON.
 * Busy polling is asynchronous so a blocked process never stalls its event loop.
 * Leave the sidecar in place so waiting and newly arriving writers use the same file.
 */
export async function withWriterLock<T>(file: string, operation: () => Promise<T>, signal?: AbortSignal, waitMs = 2_000): Promise<T> {
  signal?.throwIfAborted();
  const { DatabaseSync } = await import('node:sqlite');
  const lock = new DatabaseSync(file + '.write-lock.sqlite', { timeout: 0 });
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        // The low byte is SQLITE_BUSY, including extended busy codes.
        const errcode = (error as { errcode?: number }).errcode ?? 0;
        if ((errcode & 255) !== 5) throw error;
        if (Date.now() >= deadline) throw new Error('数据文件正在被另一个进程写入，请重试', { cause: error });
        await wait(25, undefined, { signal });
      }
    }
    return await operation();
  } finally {
    // Closing a connection releases the transaction even when the callback failed.
    lock.close();
  }
}
