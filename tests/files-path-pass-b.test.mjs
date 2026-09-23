/**
 * Pass B spec for the vendored DeepSeek Files path: bounded stale-id retry,
 * quota recovery, list/delete error shaping, the provider caps and the explicit
 * index location. Imports the BUILT tree (run \`node scripts/build.mjs\` first).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeepSeekFileStore, DeepSeekFilesClient, DeepSeekFilesError, DeepSeekUploadIndex, LlmError,
  MAX_FILE_EXPIRY_SECONDS, MAX_FILE_UPLOAD_BYTES, MAX_QUOTA_CLEANUP_ROUNDS, MAX_STORED_FILE_BYTES, MAX_STORED_FILE_COUNT,
  MIN_FILE_EXPIRY_SECONDS, cleanupBatchLimit, createDeepSeekChatAdapter, deepSeekFileScope, deepSeekFilesIndexPath,
  quotaCleanupBatch, resolveChatConnection,
} from '../vendor/deepseek-chat/index.mjs';

const NL = String.fromCharCode(10);
const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);
const ATTACHMENT_ID = 'sha256:' + 'a'.repeat(64);
const VARIANT_ID = 'sha256:' + 'b'.repeat(64);
const FILE_KEY = 'files-pass-b-secret';
const BASE_URL = 'https://api.deepseek.com';
const FILE_CONNECTION = { baseURL: BASE_URL, apiKey: FILE_KEY, protocol: 'chat-completions' };
const FILE_POLICY = { expiresAfterSeconds: 3600, refreshMarginSeconds: 60, quotaCleanupBatch: 2 };
const FILE_VERSION = {
  mediaType: 'image/png', data: PNG_BYTES, bytes: PNG_BYTES.byteLength, width: 2, height: 2,
  attachment: { attachmentId: ATTACHMENT_ID, mediaType: 'image/png' }, variantId: VARIANT_ID,
};

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function filesDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-pass-b-'));
  dirs.push(dir);
  return dir;
}

function sseResponse(payloads) {
  const text = payloads.map(payload => 'data: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)) + NL + NL).join('');
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function uploadedFile(id, bytes, createdAt, expiresAt) {
  return new Response(JSON.stringify({
    id, object: 'file', bytes, created_at: createdAt, filename: 'dsh-pass-b.png', purpose: 'user_data', expires_at: expiresAt,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fileListResponse(files) {
  return new Response(JSON.stringify({ object: 'list', data: files, has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function deletedResponse(id) {
  return new Response(JSON.stringify({ id, object: 'file', deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function imageRequest() {
  return {
    provider: 'preset-deepseek-chat', model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: ATTACHMENT_ID, mediaType: 'image/png', width: 2, height: 2 } }] }],
  };
}

/** A 400 whose detail classifies as "the provider no longer knows this file id". */
function staleFileResponse() {
  return new Response(JSON.stringify({ error: { message: 'file file-1 not found', code: 'invalid_request_error', type: 'invalid_request_error' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
}

function makeAdapter(store, chatFetch) {
  return createDeepSeekChatAdapter({
    connection: () => resolveChatConnection({ streamIdleTimeoutMs: 50 }),
    resolveApiKey: async () => FILE_KEY,
    resolveRequestImages: async () => new Map([[ATTACHMENT_ID, FILE_VERSION]]),
    resolveFiles: () => store,
    fetch: chatFetch,
  });
}

test('a stale file id is invalidated and retried with exactly one re-upload', async () => {
  const dir = await filesDir();
  const path = join(dir, 'deepseek-files.json');
  const uploadIds = [];
  const store = new DeepSeekFileStore({
    indexPath: path,
    now: () => 1_000_000,
    fetch: async () => {
      const id = 'file-' + (uploadIds.length + 1);
      uploadIds.push(id);
      return uploadedFile(id, PNG_BYTES.byteLength, 1_000, 9_999);
    },
  });
  const chatBodies = [];
  const adapter = makeAdapter(store, async (url, init) => {
    chatBodies.push(JSON.parse(init.body));
    return chatBodies.length === 1 ? staleFileResponse() : sseResponse(['[DONE]']);
  });
  await collect(adapter.stream(imageRequest()));
  assert.equal(chatBodies.length, 2, 'exactly one retry dispatch');
  assert.deepEqual(uploadIds, ['file-1', 'file-2'], 'exactly one re-upload');
  assert.equal(chatBodies[0].messages[0].content[1].file_id, 'file-1');
  assert.equal(chatBodies[1].messages[0].content[1].file_id, 'file-2');
  // The stale mapping is gone and the fresh upload is the durable one.
  const scope = deepSeekFileScope(BASE_URL, FILE_KEY);
  assert.equal((await new DeepSeekUploadIndex(path).get(scope, VARIANT_ID, 1_000_000, 60_000)).fileId, 'file-2');
});

test('a stale-id retry whose re-upload fails downgrades to inline base64 once', async () => {
  const dir = await filesDir();
  const path = join(dir, 'deepseek-files.json');
  let uploads = 0;
  const store = new DeepSeekFileStore({
    indexPath: path,
    now: () => 1_000_000,
    fetch: async () => {
      uploads += 1;
      // "upload failed" deliberately avoids the quota markers: a plain transport failure.
      return uploads === 1
        ? uploadedFile('file-1', PNG_BYTES.byteLength, 1_000, 9_999)
        : new Response(JSON.stringify({ error: { message: 'upload failed', code: 'server_error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    },
  });
  const chatBodies = [];
  const adapter = makeAdapter(store, async (url, init) => {
    chatBodies.push(JSON.parse(init.body));
    return chatBodies.length === 1 ? staleFileResponse() : sseResponse(['[DONE]']);
  });
  await collect(adapter.stream(imageRequest()));
  assert.equal(uploads, 2, 'the initial upload plus the one failed re-upload');
  assert.equal(chatBodies.length, 2, 'one downgrade: no third dispatch and no stream restart');
  assert.equal(chatBodies[1].messages[0].content[1].type, 'image_url');
  assert.equal(JSON.stringify(chatBodies[1]).includes('file_id'), false);
});

test('a quota failure reclaims the oldest plugin-owned files before retrying', async () => {
  const dir = await filesDir();
  const path = join(dir, 'deepseek-files.json');
  const deleted = [];
  let uploads = 0;
  const store = new DeepSeekFileStore({
    indexPath: path,
    now: () => 1_000_000,
    fetch: async (url, init) => {
      const href = String(url);
      if (init.method === 'POST') {
        uploads += 1;
        return uploads === 1
          ? new Response(JSON.stringify({ error: { message: 'storage quota exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } })
          : uploadedFile('file-new', PNG_BYTES.byteLength, 1_000, 9_999);
      }
      if (init.method === 'GET') {
        return fileListResponse([
          { id: 'file-old-1', object: 'file', bytes: 10, created_at: 1, filename: 'dsh-aaa.png', purpose: 'user_data', expires_at: 9_999 },
          { id: 'file-foreign', object: 'file', bytes: 10, created_at: 2, filename: 'other-plugin.png', purpose: 'user_data', expires_at: 9_999 },
          { id: 'file-old-2', object: 'file', bytes: 10, created_at: 3, filename: 'dsh-bbb.png', purpose: 'user_data', expires_at: 9_999 },
        ]);
      }
      const id = href.slice(href.lastIndexOf('/') + 1);
      deleted.push(id);
      return deletedResponse(id);
    },
  });
  const result = await store.ensureUploaded(FILE_VERSION, FILE_CONNECTION, FILE_POLICY);
  assert.equal(result.uploaded, true);
  assert.equal(result.record.fileId, 'file-new');
  assert.equal(uploads, 2, 'one quota failure then one successful upload');
  assert.deepEqual(deleted, ['file-old-1', 'file-old-2'], 'oldest first, foreign files untouched');
});

test('quota recovery keeps reclaiming in bounded rounds', async () => {
  const dir = await filesDir();
  const path = join(dir, 'deepseek-files.json');
  const deleted = [];
  let uploads = 0;
  const owned = [
    { id: 'file-old-1', object: 'file', bytes: 10, created_at: 1, filename: 'dsh-a.png', purpose: 'user_data', expires_at: 9_999 },
    { id: 'file-old-2', object: 'file', bytes: 10, created_at: 2, filename: 'dsh-b.png', purpose: 'user_data', expires_at: 9_999 },
  ];
  const store = new DeepSeekFileStore({
    indexPath: path,
    now: () => 1_000_000,
    fetch: async (url, init) => {
      const href = String(url);
      if (init.method === 'POST') {
        uploads += 1;
        return uploads <= 2
          ? new Response(JSON.stringify({ error: { message: 'too many files' } }), { status: 429, headers: { 'content-type': 'application/json' } })
          : uploadedFile('file-new', PNG_BYTES.byteLength, 1_000, 9_999);
      }
      if (init.method === 'GET') return fileListResponse(owned.filter(file => !deleted.includes(file.id)));
      const id = href.slice(href.lastIndexOf('/') + 1);
      deleted.push(id);
      return deletedResponse(id);
    },
  });
  const result = await store.ensureUploaded(FILE_VERSION, FILE_CONNECTION, { ...FILE_POLICY, quotaCleanupBatch: 1 });
  assert.equal(result.record.fileId, 'file-new');
  assert.equal(uploads, 3, 'two quota failures then a success, inside MAX_QUOTA_CLEANUP_ROUNDS');
  assert.deepEqual(deleted, ['file-old-1', 'file-old-2'], 'one oldest file reclaimed per round');
});

test('quota recovery is bounded when a round frees nothing', async () => {
  const dir = await filesDir();
  const path = join(dir, 'deepseek-files.json');
  const deleted = [];
  const store = new DeepSeekFileStore({
    indexPath: path,
    now: () => 1_000_000,
    fetch: async (url, init) => {
      const href = String(url);
      if (init.method === 'POST') {
        return new Response(JSON.stringify({ error: { message: 'storage quota exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      if (init.method === 'GET') {
        return fileListResponse([{ id: 'file-old', object: 'file', bytes: 10, created_at: 1, filename: 'dsh-a.png', purpose: 'user_data', expires_at: 9_999 }]);
      }
      const id = href.slice(href.lastIndexOf('/') + 1);
      deleted.push(id);
      return deletedResponse(id);
    },
  });
  await assert.rejects(
    store.ensureUploaded(FILE_VERSION, FILE_CONNECTION, { ...FILE_POLICY, quotaCleanupBatch: 1 }),
    (error) => error instanceof DeepSeekFilesError && error.code === 'RATE_LIMIT');
  assert.equal(deleted.length, MAX_QUOTA_CLEANUP_ROUNDS, 'the cleanup loop stops at its bound');
});

test('Files caps and provider errors are shaped before the network', async () => {
  const client = (fetchImpl, protocol = 'chat-completions') => new DeepSeekFilesClient({ baseURL: BASE_URL, apiKey: FILE_KEY, protocol, fetch: fetchImpl });

  // Provider status -> stable code, with the parsed detail retained.
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'FILES_API']]) {
    const failing = client(async () => new Response(JSON.stringify({ error: { message: 'provider said no', type: 't', code: 'detail-code' } }), { status }));
    await assert.rejects(failing.list(), (error) => error instanceof DeepSeekFilesError && error.code === code && error.status === status && error.detail.includes('detail-code'));
  }

  // Malformed list and mismatched delete bodies are INVALID_RESPONSE, never silent data.
  const malformedList = client(async () => new Response(JSON.stringify({ object: 'file', data: [], has_more: false }), { status: 200 }));
  await assert.rejects(malformedList.list(), (error) => error instanceof LlmError && error.code === 'INVALID_RESPONSE');
  const malformedDelete = client(async () => new Response(JSON.stringify({ id: 'someone-else', object: 'file', deleted: true }), { status: 200 }));
  await assert.rejects(malformedDelete.delete('file-1'), (error) => error instanceof LlmError && error.code === 'INVALID_RESPONSE');

  // The 128 MiB upload cap and the expiry bounds are enforced before any request.
  let network = 0;
  const capped = client(async () => { network += 1; return deletedResponse('file-1'); });
  await assert.rejects(
    capped.upload({ data: { byteLength: MAX_FILE_UPLOAD_BYTES + 1 }, mediaType: 'image/png', filename: 'x.png', expiresAfterSeconds: 3_600 }),
    (error) => error instanceof LlmError && error.code === 'INVALID_REQUEST');
  for (const seconds of [MIN_FILE_EXPIRY_SECONDS - 1, MAX_FILE_EXPIRY_SECONDS + 1, 3_600.5]) {
    await assert.rejects(
      capped.upload({ data: PNG_BYTES, mediaType: 'image/png', filename: 'x.png', expiresAfterSeconds: seconds }),
      (error) => error instanceof LlmError && error.code === 'INVALID_REQUEST');
  }
  assert.equal(network, 0, 'caps never reach the provider');
});

test('the Files client addresses the Messages root, headers and page caps separately', async () => {
  const seen = [];
  const messagesClient = new DeepSeekFilesClient({
    baseURL: BASE_URL, apiKey: FILE_KEY, protocol: 'messages',
    fetch: async (url, init) => { seen.push({ url: String(url), headers: init.headers }); return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 }); },
  });
  await messagesClient.list({ limit: 20_000 });
  assert.equal(seen[0].url.startsWith(BASE_URL + '/v1/files?'), true, 'Messages resources live under /v1');
  assert.equal(seen[0].url.includes('limit=10000'), true, 'one page clamps to the 10_000-file quota');
  assert.equal(seen[0].headers.get('x-api-key'), FILE_KEY);
  assert.equal(seen[0].headers.get('anthropic-beta'), 'files-api-2025-04-14');
  assert.equal(seen[0].headers.get('authorization'), null);

  const chatUrls = [];
  const chatClient = new DeepSeekFilesClient({
    baseURL: BASE_URL, apiKey: FILE_KEY, protocol: 'chat-completions',
    fetch: async (url, init) => { chatUrls.push({ url: String(url), headers: init.headers }); return fileListResponse([]); },
  });
  await chatClient.list();
  assert.equal(chatUrls[0].url.includes('purpose=user_data'), true);
  assert.equal(chatUrls[0].headers.get('authorization'), 'Bearer ' + FILE_KEY);
  assert.equal(chatUrls[0].headers.get('anthropic-beta'), null);

  // Limits are validated, not truncated silently.
  await assert.rejects(chatClient.list({ limit: 0 }), (error) => error instanceof LlmError && error.code === 'INVALID_REQUEST');
  await assert.rejects(chatClient.list({ limit: 2.5 }), (error) => error instanceof LlmError && error.code === 'INVALID_REQUEST');

  // Delete accepts each protocol's exact confirmation shape.
  const chatDelete = new DeepSeekFilesClient({ baseURL: BASE_URL, apiKey: FILE_KEY, protocol: 'chat-completions', fetch: async url => deletedResponse(String(url).slice(String(url).lastIndexOf('/') + 1)) });
  await chatDelete.delete('file-1');
  const messagesDelete = new DeepSeekFilesClient({ baseURL: BASE_URL, apiKey: FILE_KEY, protocol: 'messages', fetch: async () => new Response(JSON.stringify({ id: 'file-1', type: 'file_deleted' }), { status: 200 }) });
  await messagesDelete.delete('file-1');
});

test('the provider caps are declared and the cleanup batch is clamped', () => {
  assert.equal(MAX_STORED_FILE_COUNT, 10_000);
  assert.equal(MAX_STORED_FILE_BYTES, 25 * 1024 * 1024 * 1024);
  assert.equal(MAX_FILE_UPLOAD_BYTES, 128 * 1024 * 1024);
  assert.equal(MAX_QUOTA_CLEANUP_ROUNDS, 3);
  assert.equal(cleanupBatchLimit(2), 2);
  assert.equal(cleanupBatchLimit(0), 0);
  assert.equal(cleanupBatchLimit(-5), 0);
  assert.equal(cleanupBatchLimit(2.5), 0);
  assert.equal(cleanupBatchLimit(99_999), MAX_STORED_FILE_COUNT);
  const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 60 };
  assert.equal(quotaCleanupBatch({ ...policy, quotaCleanupBatch: 0 }), 1);
  assert.equal(quotaCleanupBatch({ ...policy, quotaCleanupBatch: 99_999 }), MAX_STORED_FILE_COUNT);
});

test('a 400 image rejection is normalized to the uploaded occurrence, other 400s pass through', async () => {
  const dir = await filesDir();
  const path = join(dir, 'deepseek-files.json');
  const store = new DeepSeekFileStore({
    indexPath: path, now: () => 1_000_000,
    fetch: async () => uploadedFile('file-1', PNG_BYTES.byteLength, 1_000, 9_999),
  });

  const rejecting = makeAdapter(store, async () => new Response(
    JSON.stringify({ error: { message: 'unsupported image', code: 'invalid_image' } }),
    { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(collect(rejecting.stream(imageRequest())), (error) => {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.message.includes('DeepSeek rejected normalized image'), true);
    assert.equal(error.message.includes(ATTACHMENT_ID), true, 'the diagnostic names the actual occurrence');
    assert.equal(error.message.includes('message 1, image 1'), true);
    return true;
  });

  const plain = makeAdapter(store, async () => new Response(
    JSON.stringify({ error: { message: 'bad request', code: 'invalid_request_error' } }),
    { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(collect(plain.stream(imageRequest())), (error) => {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.message, 'bad request', 'an unrelated 400 keeps the provider message');
    return true;
  });
});

test('the file store keeps its index path explicit, never a DSH home location', () => {
  assert.throws(() => new DeepSeekFileStore(), /indexPath/);
  const stateFile = join(tmpdir(), 'dsh-home-guard', 'state.json');
  assert.equal(deepSeekFilesIndexPath(stateFile), join(tmpdir(), 'dsh-home-guard', 'deepseek-files.json'));
  assert.equal(deepSeekFilesIndexPath(stateFile).includes('llm-deepseek'), false);
});
