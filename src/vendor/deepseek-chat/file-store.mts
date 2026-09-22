/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.7-alpha.1,
 * packages/llm/llm-deepseek/src/common/file-store.ts.
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * self-contained (no @deepseek-ai/* imports). The host's resolveDshHome helper is
 * deliberately NOT replicated: the durable index lives beside the plugin's own
 * state file (deepSeekFilesIndexPath), never at DSH_HOME/llm-deepseek.
 */

import { dirname, join } from 'node:path';
import { DeepSeekFilesClient, isFilesQuotaError } from './files-api.mjs';
import { LlmError } from './errors.mjs';
import type { DeepSeekFileId } from './file-id.mjs';
import type { ImageMediaType, RequestImageAttachment } from './host-types.mjs';
import { messagesApiRoot } from './messages-api.mjs';
import type { DeepSeekProtocol } from './messages-api.mjs';
import { DeepSeekUploadIndex, deepSeekFileScope } from './upload-index.mjs';
import type { DeepSeekUploadRecord } from './upload-index.mjs';

/** Shared Files-store limit for each request image, including file-id references. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const OWNED_FILE_PREFIX = 'dsh-';

/** Resolved file-store policy from the plugin configuration. */
export interface DeepSeekFilePolicy {
  expiresAfterSeconds: number;
  refreshMarginSeconds: number;
  quotaCleanupBatch: number;
}

/** Connection facts needed by file operations. */
export interface DeepSeekFileConnection {
  baseURL: string;
  apiKey: string;
  /** Files wire protocol selected by the resolved connection. */
  protocol: DeepSeekProtocol;
}

/** Result of one file-id resolution. */
export interface DeepSeekFileReference {
  record: DeepSeekUploadRecord;
  uploaded: boolean;
}

/** Testable boundaries plus the explicit index location owned by the plugin entry. */
export interface DeepSeekFileStoreOptions {
  /** Pre-built index; takes precedence over indexPath. */
  index?: DeepSeekUploadIndex;
  /** JSON index path; the plugin entry passes the directory of its state file. */
  indexPath?: string;
  now?: () => number;
  fetch?: typeof fetch;
}

interface SharedUpload {
  controller: AbortController;
  promise: Promise<DeepSeekFileReference>;
  settled: boolean;
  waiters: number;
}

/**
 * Durable upload index path for one plugin state file: the index sits beside it.
 * @param stateFilePath - absolute path of the plugin's own state.json.
 * @returns absolute JSON index path.
 */
export function deepSeekFilesIndexPath(stateFilePath: string): string {
  return join(dirname(stateFilePath), 'deepseek-files.json');
}

/** The Files resource's parent URL distinguishes custom protocol namespaces. */
function fileScope(connection: DeepSeekFileConnection) {
  return deepSeekFileScope(
    connection.protocol === 'messages' ? messagesApiRoot(connection.baseURL) : connection.baseURL,
    connection.apiKey,
  );
}

/** Upload identity required by the cache key; a guessed key is never persisted. */
function uploadIdentity(version: RequestImageAttachment): { attachmentId: string; variantId: string } {
  const attachmentId = version.attachment?.attachmentId;
  const variantId = version.variantId;
  if (typeof attachmentId !== 'string' || attachmentId.length === 0
    || typeof variantId !== 'string' || variantId.length === 0) {
    throw new LlmError('DeepSeek request image has no upload identity (attachmentId/variantId).', 'INVALID_REQUEST');
  }
  return { attachmentId, variantId };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error('DeepSeek file upload cancelled with a non-Error reason.', { cause: reason });
}

function uploadFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('DeepSeek file upload failed with a non-Error reason.', { cause: error });
}

function waitForUpload(operation: SharedUpload, signal: AbortSignal | undefined): Promise<DeepSeekFileReference> {
  signal?.throwIfAborted();
  operation.waiters += 1;
  let released = false;
  const release = (cancelledReason?: Error): void => {
    if (released) return;
    released = true;
    operation.waiters -= 1;
    if (cancelledReason !== undefined && operation.waiters === 0 && !operation.settled) {
      operation.controller.abort(cancelledReason);
    }
  };
  if (signal === undefined) {
    return operation.promise.finally(() => {
      release();
    });
  }
  return new Promise<DeepSeekFileReference>((resolve, reject) => {
    const abort = (): void => {
      const reason = abortReason(signal);
      release(reason);
      reject(reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.promise.then((value) => {
      signal.removeEventListener('abort', abort);
      release();
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      release();
      reject(uploadFailure(error));
    });
  });
}

function imageMediaType(value: string): ImageMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value;
  throw new LlmError('DeepSeek Files API cannot upload media type ' + value + '.', 'INVALID_REQUEST');
}

function extension(mediaType: ImageMediaType): 'png' | 'jpeg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpeg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
  }
}

function filename(attachmentId: string, variantId: string, mediaType: ImageMediaType): string {
  const attachment = attachmentId.slice('sha256:'.length, 'sha256:'.length + 16);
  const variant = variantId.slice('sha256:'.length, 'sha256:'.length + 8);
  return OWNED_FILE_PREFIX + attachment + '-' + variant + '.' + extension(mediaType);
}

/** User-scoped durable file-id reuse for the DeepSeek route. */
export class DeepSeekFileStore {
  private readonly index: DeepSeekUploadIndex;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly inflight = new Map<string, SharedUpload>();

  /**
   * @param options - testable index, clock, and transport boundaries. An index or
   *   indexPath is mandatory: the vendored tree cannot resolve a DSH home.
   */
  constructor(options: DeepSeekFileStoreOptions = {}) {
    if (options.index !== undefined) this.index = options.index;
    else if (options.indexPath !== undefined) this.index = new DeepSeekUploadIndex(options.indexPath);
    else throw new Error('deepseek files: DeepSeekFileStore needs an index or indexPath beside the plugin state file.');
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch;
  }

  private client(connection: DeepSeekFileConnection): DeepSeekFilesClient {
    return new DeepSeekFilesClient({
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      protocol: connection.protocol,
      ...this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl },
    });
  }

  /**
   * Resolve or upload one deterministic request image. Concurrent calls share one upload while retaining independent waits.
   * @param version - deterministic model-request bytes and complete transformation identity.
   * @param connection - endpoint and API-key snapshot.
   * @param policy - expiry and quota-recovery policy.
   * @param signal - cancellation of this wait; shared transport stops when no waiter remains.
   * @returns a reusable file id and whether this call published a new upload.
   */
  ensureUploaded(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    signal?.throwIfAborted();
    const identity = uploadIdentity(version);
    const scope = fileScope(connection);
    const key = scope + '\0' + identity.variantId;
    let active = this.inflight.get(key);
    if (active?.controller.signal.aborted) {
      this.inflight.delete(key);
      active = undefined;
    }
    if (active !== undefined) return waitForUpload(active, signal);
    const controller = new AbortController();
    const shared: SharedUpload = {
      controller,
      promise: undefined as unknown as Promise<DeepSeekFileReference>,
      settled: false,
      waiters: 0,
    };
    shared.promise = this.ensureUploadedOnce(version, identity, connection, policy, controller.signal).then((value) => {
      shared.settled = true;
      return value;
    }, (error: unknown) => {
      shared.settled = true;
      throw uploadFailure(error);
    });
    this.inflight.set(key, shared);
    void shared.promise.finally(() => {
      if (this.inflight.get(key) === shared) this.inflight.delete(key);
    }).catch(() => {});
    return waitForUpload(shared, signal);
  }

  private async ensureUploadedOnce(
    version: RequestImageAttachment,
    identity: { attachmentId: string; variantId: string },
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    if (version.bytes > MAX_IMAGE_BYTES) {
      throw new LlmError('DeepSeek image exceeds the 32 MiB per-image limit.', 'INVALID_REQUEST');
    }
    const mediaType = imageMediaType(version.mediaType);
    const scope = fileScope(connection);
    const now = this.now();
    const marginMs = policy.refreshMarginSeconds * 1_000;
    const cached = await this.index.get(scope, identity.variantId, now, marginMs);
    if (cached !== undefined) return { record: cached, uploaded: false };

    const client = this.client(connection);
    const upload = async (): Promise<DeepSeekUploadRecord> => {
      const remote = await client.upload({
        data: version.data,
        mediaType,
        filename: filename(identity.attachmentId, identity.variantId, mediaType),
        expiresAfterSeconds: policy.expiresAfterSeconds,
        signal,
      });
      if (remote.bytes !== version.data.byteLength) {
        throw new LlmError('DeepSeek Files API upload response does not match the submitted image.', 'INVALID_RESPONSE');
      }
      return {
        scope,
        attachmentId: identity.attachmentId,
        variantId: identity.variantId,
        fileId: remote.id,
        bytes: remote.bytes,
        createdAt: remote.createdAt * 1_000,
        expiresAt: remote.expiresAt * 1_000,
      };
    };

    let candidate: DeepSeekUploadRecord;
    try {
      candidate = await upload();
    } catch (error: unknown) {
      if (!isFilesQuotaError(error)) throw error;
      const deleted = await this.reclaimOldestOwned(connection, policy.quotaCleanupBatch, signal);
      if (deleted === 0) throw error;
      candidate = await upload();
    }
    const committed = await this.index.commit(candidate, this.now(), marginMs);
    if (!committed.accepted) {
      try {
        await client.delete(candidate.fileId, signal);
      } catch {
        // The winning mapping is durable. A failed duplicate cleanup affects quota only and is retried by recovery.
      }
    }
    return { record: committed.record, uploaded: committed.accepted };
  }

  /**
   * Invalidate one exact local mapping after a model request rejects its remote id.
   * @param version - request-image version whose remote generation failed.
   * @param fileId - exact rejected file id.
   * @param connection - endpoint and API-key snapshot.
   */
  async invalidate(
    version: RequestImageAttachment,
    fileId: DeepSeekFileId,
    connection: DeepSeekFileConnection,
  ): Promise<void> {
    const identity = uploadIdentity(version);
    await this.index.remove(fileScope(connection), identity.variantId, fileId);
  }

  /**
   * Delete the indexed remote file for one attachment and remove its local mapping.
   * @param version - exact request-image version to release.
   * @param connection - endpoint and API-key snapshot.
   * @param policy - expiry policy used to locate a reusable mapping.
   * @param signal - request cancellation.
   * @returns whether an indexed file existed and was deleted.
   */
  async release(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const identity = uploadIdentity(version);
    const scope = fileScope(connection);
    const record = await this.index.get(
      scope,
      identity.variantId,
      this.now(),
      policy.refreshMarginSeconds * 1_000,
    );
    if (record === undefined) return false;
    await this.client(connection).delete(record.fileId, signal);
    await this.index.remove(scope, identity.variantId, record.fileId);
    return true;
  }

  /**
   * Delete the oldest provider files whose names identify plugin ownership.
   * @param connection - endpoint and API-key snapshot.
   * @param count - positive maximum number of files to delete.
   * @param signal - request cancellation.
   * @returns number of successfully deleted files.
   */
  async reclaimOldestOwned(
    connection: DeepSeekFileConnection,
    count: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const client = this.client(connection);
    let after: DeepSeekFileId | undefined;
    const owned: { id: DeepSeekFileId; createdAt: number }[] = [];
    while (connection.protocol === 'messages' || owned.length < count) {
      const page = await client.list({
        ...after === undefined ? {} : { after },
        limit: 1_000,
        order: 'asc',
        ...signal === undefined ? {} : { signal },
      });
      for (const file of page.data) {
        if (!file.filename.startsWith(OWNED_FILE_PREFIX)) continue;
        owned.push({ id: file.id, createdAt: file.createdAt });
        if (connection.protocol === 'chat-completions' && owned.length === count) break;
      }
      if (connection.protocol === 'messages') {
        // Messages offers no ascending-order query; retain the oldest candidates across every page.
        owned.sort((left, right) => left.createdAt - right.createdAt);
        owned.splice(count);
      }
      if (!page.hasMore || page.lastId === undefined || page.lastId === after) break;
      after = page.lastId;
    }
    for (const file of owned) await client.delete(file.id, signal);
    return owned.length;
  }

  /**
   * Delete every remote plugin-owned file in the active API-key namespace and clear its index.
   * @param connection - endpoint and API-key snapshot.
   * @param signal - request cancellation.
   * @returns number of deleted files.
   */
  async releaseAll(connection: DeepSeekFileConnection, signal?: AbortSignal): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.reclaimOldestOwned(connection, 1_000, signal);
      total += deleted;
      if (deleted < 1_000) break;
    }
    await this.index.clear(fileScope(connection));
    return total;
  }
}
