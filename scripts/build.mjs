#!/usr/bin/env node
// Build host and browser TypeScript sources into the published JavaScript layout.
//
// Sources live in src/**/*.mts and compile to dist/**, then this script copies the
// emitted files back to the package root so the published layout (and every
// import.meta.url-relative asset path) stays exactly as it was before the
// TypeScript migration.
//
// A failed compilation never replaces the published JavaScript artifacts.
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

  try {
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
  } catch (error) {
    const report = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    process.stderr.write(report);
    throw new Error('build: TypeScript compilation failed; published files were not changed', { cause: error });
  }

  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.display.json')], { cwd: root, stdio: 'inherit' });

  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.browser.json')], { cwd: root, stdio: 'inherit' });

  const emit = async (from, to) => {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { force: true });
  };

  for (const entry of await readdir(dist, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      await emit(join(dist, entry.name), join(root, entry.name));
    }
  }
  await emit(join(dist, 'display-package', 'packages', 'display-regex', 'src', 'index.mjs'), join(root, 'packages', 'display-regex', 'index.mjs'));
  for (const file of ['display-regex', 'prompt-regex', 'macros', 'compaction']) {
    await emit(join(dist, 'lib', file + '.mjs'), join(root, 'packages', 'display-regex', 'regex', file + '.mjs'));
  }
  const browser = join(dist, 'browser');
  const { readFile, writeFile } = await import('node:fs/promises');
  for (const file of ['runtime.mjs', 'executor.mjs', 'client.js']) {
    const source = join(browser, 'packages', 'display-regex', 'src', 'client', file);
    let text = await readFile(source, 'utf8');
    if (file === 'client.js') text = text.replace("import('./runtime.mjs')", "import('/preset-enhance-display/runtime.mjs')").replace(/export \{\};?\s*$/, '');
    await writeFile(join(root, 'packages', 'display-regex', file), text);
  }
  for (const file of ['display-availability.js', 'regex-editor.js', 'request-preview.js', 'disclosures.js', 'scroll-state.js']) {
    await emit(join(browser, 'src', 'client', file), join(root, 'web', file));
  }
  await writeFile(join(root, 'client.js'), (await readFile(join(browser, 'src', 'client', 'entry.js'), 'utf8')).replace(/^export \{\};?\s*$/gm, ''));
  // Request preview remains a classic script loaded before the workbench module.
  await writeFile(join(root, 'web', 'request-preview.js'), (await readFile(join(browser, 'src', 'client', 'request-preview.js'), 'utf8')).replace(/^export \{\};?\s*$/gm, ''));
  const worker = (await readFile(join(browser, 'src', 'client', 'worker', 'regex-worker.js'), 'utf8')).replace("'../../lib/display-regex.mjs'", "'./regex/display-regex.mjs'");
  await writeFile(join(root, 'web', 'regex-worker.js'), worker);
  await writeFile(join(root, 'packages', 'display-regex', 'worker.js'), worker);
  await emit(join(dist, 'display-package', 'src', 'display-api.d.mts'), join(root, 'display-api.d.mts'));
  await emit(join(dist, 'display-package', 'src', 'display-api.d.mts'), join(root, 'packages', 'display-regex', 'display-api.d.mts'));
  await emit(join(dist, 'display-api.mjs'), join(root, 'packages', 'display-regex', 'display-api.mjs'));
  // The host source's relative import is adjusted to the published package-local contract.
  const displayEntry = join(root, 'packages', 'display-regex', 'index.mjs');
  await writeFile(displayEntry, (await readFile(displayEntry, 'utf8')).replace("'../../../src/display-api.mjs'", "'./display-api.mjs'"));
  await emit(join(dist, 'display-package', 'packages', 'bundle', 'src', 'index.mjs'), join(root, 'packages', 'bundle', 'index.mjs'));
  for (const pkg of ['bundle', 'display-regex']) await emit(join(root, 'icon.svg'), join(root, 'packages', pkg, 'icon.svg'));
  await emit(join(root, 'LICENSE'), join(root, 'packages', 'display-regex', 'LICENSE'));
  // The public template contract is self-contained: consumers need no host/internal types.
  await emit(join(root, 'src', 'template-api.d.mts'), join(root, 'templates.d.mts'));
  for (const entry of await readdir(join(dist, 'lib'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      await emit(join(dist, 'lib', entry.name), join(root, 'lib', entry.name));
    }
  }
  // Vendored upstream code keeps its own tree so the copied licence and
  // provenance stay visible; it ships next to lib/ in the published package.
  const vendorDist = join(dist, 'vendor');
  if (await stat(vendorDist).then(() => true, () => false)) {
    await cp(vendorDist, join(root, 'vendor'), { recursive: true, force: true });
  }

  console.log('build: emitted host and browser artifacts from TypeScript (clean typecheck)');
} finally {
  await unlink(lockPath).catch(() => {});
}
