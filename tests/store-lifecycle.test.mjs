/**
 * Storage lifecycle spec: per-path write coordination across PresetStore
 * instances (apply() creates one per activation), deterministic disposal via
 * close()/drain(), and the non-creating read() contract.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore, PresetStoreClosedError } from '../lib/store.mjs';

const dirs = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function newStoreFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-store-lifecycle-'));
  dirs.push(dir);
  return { dir, file: join(dir, 'state.json') };
}

async function leftovers(dir) {
  return (await readdir(dir)).filter(name => name !== 'state.json' && name !== 'state.json.write-lock.sqlite');
}

test('read() of a missing file returns a fresh state and never creates it', async () => {
  const { dir, file } = await newStoreFile();
  const store = new PresetStore(file);
  const state = await store.read();
  assert.equal(state.version, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.toolGroups, []);
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
  await store.drain();
  assert.deepEqual(await leftovers(dir), [], 'draining an idle store must not touch the directory');
});

test('drain waits for an in-flight transaction and lets it land', async () => {
  const { dir, file } = await newStoreFile();
  const store = new PresetStore(file);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const write = store.transaction(async state => { state.revision += 1; await gate; return 'written'; });
  let drained = false;
  const drainedPromise = store.drain().then(() => { drained = true; });
  await delay(25);
  assert.equal(drained, false, 'drain must not resolve while the write is in flight');
  assert.equal((await store.read()).revision, 0, 'the state file is still untouched');
  release();
  assert.equal(await write, 'written');
  await drainedPromise;
  assert.equal(drained, true);
  assert.equal((await new PresetStore(file).read()).revision, 1);
  assert.deepEqual(await leftovers(dir), [], 'atomic writes must not leave temp files');
});

test('drain is safe to call twice and never rejects on a failed transaction', async () => {
  const { file } = await newStoreFile();
  const store = new PresetStore(file);
  let caught = null;
  const failing = store.transaction(() => { throw new Error('boom'); }).catch(error => { caught = error; });
  await store.drain();
  await store.drain();
  await failing;
  assert.match(caught.message, /boom/);
  await store.transaction(state => { state.revision += 1; });
  assert.equal((await store.read()).revision, 1, 'one failure must not stall the queue');
});

test('close refuses new transactions deterministically and is idempotent', async () => {
  const { file } = await newStoreFile();
  const store = new PresetStore(file);
  await store.transaction(state => { state.revision += 1; });
  assert.equal(store.closed, false);
  await store.close();
  assert.equal(store.closed, true);
  await assert.rejects(
    store.transaction(state => { state.revision += 1; }),
    error => error instanceof PresetStoreClosedError && error.code === 'PRESET_STORE_CLOSED');
  await store.close();
  await store.drain();
  assert.equal((await store.read()).revision, 1, 'reads stay available after close');
});

test('close lets already-queued transactions finish and rejects later ones', async () => {
  const { file } = await newStoreFile();
  const store = new PresetStore(file);
  const order = [];
  const first = store.transaction(async state => { state.revision += 1; await delay(30); order.push('first'); });
  const second = store.transaction(state => { state.revision += 1; order.push('second'); });
  const closed = store.close();
  await assert.rejects(store.transaction(state => { state.revision += 1; }), /已关闭/);
  await Promise.all([first, second, closed]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal((await new PresetStore(file).read()).revision, 2);
});

test('close resolves only after the in-flight transaction flushed', async () => {
  const { file } = await newStoreFile();
  const store = new PresetStore(file);
  let finished = false;
  const write = store.transaction(async state => { await delay(30); state.revision += 1; finished = true; });
  let observedAtClose = null;
  const closed = store.close().then(() => { observedAtClose = finished; });
  await delay(10);
  assert.equal(observedAtClose, null, 'close must not resolve before the transaction ended');
  await write;
  await closed;
  assert.equal(observedAtClose, true);
  assert.equal((await new PresetStore(file).read()).revision, 1);
});

test('two instances over the same path cannot lose an update', async () => {
  const { file } = await newStoreFile();
  const first = new PresetStore(file);
  const second = new PresetStore(file);
  await first.transaction(state => { state.revision += 1; });
  // The two read-modify-writes overlap; a per-instance queue would let both read
  // revision 1 and write revision 2, losing one increment.
  await Promise.all([
    first.transaction(async state => { state.revision += 1; await delay(40); }),
    second.transaction(async state => { state.revision += 1; await delay(5); }),
  ]);
  assert.equal((await new PresetStore(file).read()).revision, 3);
});

test('concurrent transactions from several instances are fully serialized', async () => {
  const { dir, file } = await newStoreFile();
  const instances = [new PresetStore(file), new PresetStore(file), new PresetStore(file)];
  await Promise.all(Array.from({ length: 24 }, (_, index) => instances[index % instances.length].transaction(async state => {
    state.revision += 1;
    (state.writeLog ??= []).push(index);
    await delay(1);
  })));
  const state = await new PresetStore(file).read();
  assert.equal(state.revision, 24);
  assert.equal(state.writeLog.length, 24);
  assert.equal(new Set(state.writeLog).size, 24);
  assert.deepEqual(await leftovers(dir), []);
});

test('a failing transaction writes nothing and the queue keeps working', async () => {
  const { dir, file } = await newStoreFile();
  const store = new PresetStore(file);
  await store.transaction(state => { state.revision += 1; });
  await assert.rejects(store.transaction(state => {
    state.revision += 1;
    state.toolGroups = [{ id: 'g1', name: 'G', description: '', order: 100, members: [] }];
    throw new Error('boom');
  }), /boom/);
  const afterFailure = await store.read();
  assert.equal(afterFailure.revision, 1);
  assert.deepEqual(afterFailure.toolGroups, [], 'a failed callback must not reach the file');
  assert.deepEqual(await leftovers(dir), []);

  const other = new PresetStore(file);
  await store.transaction(state => { state.revision += 1; });
  await other.transaction(state => { state.revision += 1; });
  assert.equal((await store.read()).revision, 3);
});

test('closing one instance does not block a newer instance on the same path', async () => {
  const { file } = await newStoreFile();
  const old = new PresetStore(file);
  await old.transaction(state => { state.revision += 1; });
  await old.close();
  const fresh = new PresetStore(file);
  await fresh.transaction(state => { state.revision += 1; });
  assert.equal((await fresh.read()).revision, 2);
});

test('a compacted legacy state keeps durable variables and removes compiled history', async () => {
  const { file } = await newStoreFile();
  await writeFile(file, JSON.stringify({
    version: 1, revision: 4, global: { x: 'current' },
    sessions: { s: { presetId: 'p', key: 'old-key', result: {
      local: { counter: '17' }, global: { x: 'stale' }, messages: [{ content: 'fictional private history' }],
    } } },
  }));
  const store = new PresetStore(file);
  await store.maintain();
  const raw = await readFile(file, 'utf8');
  const state = JSON.parse(raw);
  assert.deepEqual(state.sessions.s, { presetId: 'p', result: { local: { counter: '17' } }, replay: { key: 'old-key' } });
  assert.deepEqual(state.global, { x: 'current' });
  assert.equal(state.revision, 4);
  assert.ok(!raw.includes('fictional private history'));
  await store.maintain();
  assert.equal(await readFile(file, 'utf8'), raw);
});

test('separate processes preserve both updates to the same state file', async () => {
  const { file } = await newStoreFile();
  const store = new PresetStore(file);
  await store.transaction(state => { state.revision = 10; });
  const source = `
    import { PresetStore } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    const store = new PresetStore(process.argv[1]);
    await store.transaction(async state => {
      await new Promise(resolve => setTimeout(resolve, 180));
      state.global[process.argv[2]] = 'saved';
      state.revision++;
    });
  `;
  const run = name => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, name], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.setEncoding('utf8').on('data', text => { error += text; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(error || String(code))));
  });
  await Promise.all([run('first'), run('second')]);
  const state = await store.read();
  assert.equal(state.revision, 12);
  assert.deepEqual(state.global, { first: 'saved', second: 'saved' });
});

test('a process that exits inside the transaction releases its writer lock', async () => {
  const { file } = await newStoreFile();
  const source = `
    import { PresetStore } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    await new PresetStore(process.argv[1]).transaction(() => process.exit(9));
  `;
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, file], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(status, 9);
  const store = new PresetStore(file);
  await store.transaction(state => { state.revision = 1; });
  assert.equal((await store.read()).revision, 1);
});

test('maintenance reclaims only owned temp files and preserves recent legacy writes', async () => {
  const { dir, file } = await newStoreFile();
  const current = 'state.json.write-aaaaaaaa-1111-2222-3333-444444444444.tmp';
  const legacy = 'state.json.bbbbbbbb-1111-2222-3333-444444444444.tmp';
  const recent = 'state.json.cccccccc-1111-2222-3333-444444444444.tmp';
  const other = 'other.json.write-dddddddd-1111-2222-3333-444444444444.tmp';
  const backup = 'state.json.manual-backup.tmp';
  await Promise.all([current, legacy, recent, other, backup].map(name => writeFile(join(dir, name), 'fictional bytes')));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(join(dir, legacy), old, old);
  await new PresetStore(file).maintain();
  assert.deepEqual((await leftovers(dir)).sort(), [recent, other, backup].sort());
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});
