#!/usr/bin/env node
// Build the host-side TypeScript sources into the published JavaScript layout.
//
// Sources live in src/**/*.mts and compile to dist/**, then this script copies the
// emitted files back to the package root so the published layout (and every
// import.meta.url-relative asset path) stays exactly as it was before the
// TypeScript migration.
//
// tsc still emits when it reports type errors; this script keeps going and
// reports them so the runtime can be exercised mid-migration. Run
// `npm run typecheck` (or `npm run verify`) to gate on a clean typecheck.
//
// A cross-process lock serialises builds: several agents share this checkout.
import { cp, mkdir, rm, readdir, open, stat, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const lockPath = join(root, '.build.lock');
const LOCK_TIMEOUT_MS = 10 * 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_TIMEOUT_MS) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error('build: timed out waiting for .build.lock');
      await sleep(250);
    }
  }
}

await acquireLock();
try {
  await rm(dist, { recursive: true, force: true });

  let typeErrors = 0;
  try {
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
  } catch (error) {
    const report = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    typeErrors = report.split(/\r?\n/).filter(line => /error TS\d+/.test(line)).length;
    if (typeErrors === 0) {
      process.stderr.write(report);
      console.error('build: tsc failed without type errors');
      process.exitCode = 1;
      throw new Error('tsc failed');
    }
  }

  const emit = async (from, to) => {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { force: true });
  };

  for (const entry of await readdir(dist, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      await emit(join(dist, entry.name), join(root, entry.name));
    }
  }
  for (const entry of await readdir(join(dist, 'lib'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      await emit(join(dist, 'lib', entry.name), join(root, 'lib', entry.name));
    }
  }

  if (typeErrors > 0) {
    console.error(`build: emitted from src/**/*.mts with ${typeErrors} type error(s) — run \`npm run typecheck\``);
  } else {
    console.log('build: emitted index.mjs, mode.mjs and lib/*.mjs from src/**/*.mts (clean typecheck)');
  }
} finally {
  await unlink(lockPath).catch(() => {});
}
